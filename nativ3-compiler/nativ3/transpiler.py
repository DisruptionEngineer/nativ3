"""
Nativ3 Qiskit Transpiler Plugin
================================
Two transpiler passes that integrate relay-bit topology analysis
into the standard Qiskit compilation pipeline.

RelayAnalysisPass  — annotates the DAG with relay-bit classification
RelayEliminationPass — rewrites chain patterns to stars

Usage as standalone passes:
    from qiskit.transpiler import PassManager
    from nativ3.transpiler import RelayAnalysisPass, RelayEliminationPass

    pm = PassManager([
        RelayAnalysisPass(),
        RelayEliminationPass(),
    ])
    optimized = pm.run(circuit)

Usage via Qiskit plugin entry points:
    # Automatically discovered when nativ3 is installed
    from qiskit.transpiler.preset_passmanagers.plugin import list_stage_plugins
    print(list_stage_plugins('optimization'))

Reference: DOI 10.5281/zenodo.19210676
"""

from typing import Optional
import numpy as np

from qiskit.circuit import QuantumCircuit
from qiskit.dagcircuit import DAGCircuit
from qiskit.transpiler.basepasses import AnalysisPass, TransformationPass

from .topology import GateRecord, NodeType, classify_circuit


class RelayAnalysisPass(AnalysisPass):
    """Annotate each qubit in the DAG with its relay-bit classification.

    After this pass runs, the property set contains:

        property_set['nativ3_topology']  — TopologyAnalysis object
        property_set['nativ3_relays']    — set of relay qubit indices
        property_set['nativ3_isolated']  — bool, True if fully fault-isolated
        property_set['nativ3_summary']   — human-readable summary string

    This pass is pure analysis — it never modifies the circuit.
    """

    def run(self, dag: DAGCircuit) -> None:
        gates = _extract_gates(dag)
        n_qubits = dag.num_qubits()
        analysis = classify_circuit(gates, n_qubits)

        relay_set = {
            q for q, info in analysis.qubits.items()
            if info.node_type == NodeType.RELAY
        }

        self.property_set['nativ3_topology'] = analysis
        self.property_set['nativ3_relays'] = relay_set
        self.property_set['nativ3_isolated'] = analysis.fully_isolated
        self.property_set['nativ3_summary'] = analysis.summary()


class RelayEliminationPass(TransformationPass):
    """Rewrite chain sub-circuits to star topology, eliminating relays.

    For each consecutive CNOT pair (a→b, b→c) where b is a relay qubit,
    rewrites to (a→b, a→c) — converting the chain to a star rooted at a.

    This changes circuit semantics (Theorem 1: star ≠ chain for non-trivial
    middleman states), but eliminates error propagation through relay qubits.

    Parameters:
        max_fidelity_loss: Skip rewrites where estimated fidelity loss exceeds
            this threshold. Default 0.5 (50%). Set to 1.0 for aggressive mode.
        analyze_first: If True and RelayAnalysisPass hasn't run yet, run
            analysis before attempting rewrites. Default True.
    """

    def __init__(self, max_fidelity_loss: float = 0.5,
                 analyze_first: bool = True):
        super().__init__()
        self.max_fidelity_loss = max_fidelity_loss
        self.analyze_first = analyze_first

    def run(self, dag: DAGCircuit) -> DAGCircuit:
        # Run analysis if not already done
        if self.analyze_first and 'nativ3_topology' not in self.property_set:
            gates = _extract_gates(dag)
            n_qubits = dag.num_qubits()
            analysis = classify_circuit(gates, n_qubits)
            self.property_set['nativ3_topology'] = analysis
            self.property_set['nativ3_relays'] = {
                q for q, info in analysis.qubits.items()
                if info.node_type == NodeType.RELAY
            }
            self.property_set['nativ3_isolated'] = analysis.fully_isolated

        relay_set = self.property_set.get('nativ3_relays', set())

        if not relay_set:
            return dag

        # Collect CX nodes in topological order
        cx_nodes = [
            node for node in dag.topological_op_nodes()
            if node.op.name in ('cx', 'CX', 'cnot')
        ]

        if len(cx_nodes) < 2:
            return dag

        # Find chain patterns: (a→b, b→c) where b is a relay
        rewrites = []
        skip = set()

        for i in range(len(cx_nodes) - 1):
            if i in skip:
                continue

            n1 = cx_nodes[i]
            n2 = cx_nodes[i + 1]

            q1_ctrl = dag.find_bit(n1.qargs[0]).index
            q1_targ = dag.find_bit(n1.qargs[1]).index
            q2_ctrl = dag.find_bit(n2.qargs[0]).index
            q2_targ = dag.find_bit(n2.qargs[1]).index

            # Chain pattern: n1's target is n2's control, and it's a relay
            if q1_targ == q2_ctrl and q1_targ in relay_set:
                relay_q = q1_targ

                # Estimate fidelity cost for this relay
                fidelity_loss = 1.0 - np.cos(np.pi / 4) ** 4  # default estimate
                if fidelity_loss <= self.max_fidelity_loss:
                    rewrites.append((n1, n2, q1_ctrl, q1_targ, q2_targ))
                    skip.add(i + 1)

        if not rewrites:
            return dag

        # Apply rewrites: replace (a→b, b→c) with (a→b, a→c)
        for n1, n2, hub, relay, spoke in rewrites:
            # Replace n2's control from relay to hub
            # We do this by removing n2 and inserting a new CX(hub, spoke)
            dag.remove_op_node(n2)

            mini = DAGCircuit()
            qr = QuantumCircuit(dag.num_qubits())
            mini.add_qubits(qr.qubits)
            mini.apply_operation_back(
                n1.op.__class__(),
                [qr.qubits[hub], qr.qubits[spoke]],
                [],
            )
            # Wire after n1
            dag.compose(mini, qubits=qr.qubits)

        # Re-analyze after rewrites
        new_gates = _extract_gates(dag)
        n_qubits = dag.num_qubits()
        new_analysis = classify_circuit(new_gates, n_qubits)

        self.property_set['nativ3_topology'] = new_analysis
        self.property_set['nativ3_relays'] = {
            q for q, info in new_analysis.qubits.items()
            if info.node_type == NodeType.RELAY
        }
        self.property_set['nativ3_isolated'] = new_analysis.fully_isolated
        self.property_set['nativ3_summary'] = new_analysis.summary()
        self.property_set['nativ3_rewrites'] = len(rewrites)

        return dag


def _extract_gates(dag: DAGCircuit):
    """Extract GateRecord list from a DAGCircuit."""
    gates = []
    t = 0
    for node in dag.topological_op_nodes():
        if node.op.name in ('cx', 'CX', 'cnot'):
            ctrl = dag.find_bit(node.qargs[0]).index
            targ = dag.find_bit(node.qargs[1]).index
            gates.append(GateRecord(ctrl, targ, t, f"cx({ctrl},{targ})"))
            t += 1
        elif node.op.name == 'cz':
            q0 = dag.find_bit(node.qargs[0]).index
            q1 = dag.find_bit(node.qargs[1]).index
            gates.append(GateRecord(q0, q1, t, f"cz({q0},{q1})"))
            t += 1
        elif node.op.name == 'ccx':
            c1 = dag.find_bit(node.qargs[0]).index
            c2 = dag.find_bit(node.qargs[1]).index
            targ = dag.find_bit(node.qargs[2]).index
            gates.append(GateRecord(c1, targ, t, f"ccx"))
            gates.append(GateRecord(c2, targ, t, f"ccx"))
            t += 1
        elif node.op.name == 'swap':
            q0 = dag.find_bit(node.qargs[0]).index
            q1 = dag.find_bit(node.qargs[1]).index
            gates.append(GateRecord(q0, q1, t, "swap-1"))
            gates.append(GateRecord(q1, q0, t + 1, "swap-2"))
            gates.append(GateRecord(q0, q1, t + 2, "swap-3"))
            t += 3
    return gates

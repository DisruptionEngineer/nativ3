"""
Nativ3 Topology Primitives
===========================
Defines circuit topologies as first-class objects.
Each topology knows its structure, node types, and fault properties.
"""

from dataclasses import dataclass, field
from typing import List, Optional, Dict, Tuple
from enum import Enum
import numpy as np


class NodeType(Enum):
    """Classification of a qubit's role in the gate graph."""
    VIRGIN = "virgin"      # Never involved in any gate
    HUB = "hub"            # Control-only (Type H) — source, arrows out
    SPOKE = "spoke"        # Target-only (Type S) — sink, arrows in
    RELAY = "relay"        # Target then control (Type R) — propagates errors


@dataclass
class GateRecord:
    """A single CNOT gate in the circuit."""
    control: int
    target: int
    time_step: int
    label: str = ""


@dataclass
class QubitInfo:
    """Classification and properties of a single qubit."""
    index: int
    node_type: NodeType
    relay_bit: int            # 0 = safe, 1 = propagates errors
    first_target_time: Optional[int] = None
    first_control_time: Optional[int] = None
    fault_isolated: bool = True


@dataclass
class TopologyAnalysis:
    """Complete analysis of a circuit's topology."""
    qubits: Dict[int, QubitInfo]
    gates: List[GateRecord]
    n_qubits: int
    n_relays: int
    fully_isolated: bool
    warnings: List[str] = field(default_factory=list)

    def summary(self) -> str:
        lines = [
            f"  Topology: {self.n_qubits} qubits, {len(self.gates)} gates",
            f"  Relays:   {self.n_relays} (relay bit = 1)",
            f"  Isolated: {'✓ fully fault-isolated' if self.fully_isolated else '✗ has relay nodes'}",
            "",
        ]
        for idx in sorted(self.qubits):
            q = self.qubits[idx]
            lines.append(f"    q{idx}: {q.node_type.value:<6s}  r={q.relay_bit}  "
                         f"{'SAFE' if q.fault_isolated else 'PROPAGATES'}")
        if self.warnings:
            lines.append("")
            for w in self.warnings:
                lines.append(f"  ⚠ {w}")
        return "\n".join(lines)


def classify_circuit(gates: List[GateRecord], n_qubits: int) -> TopologyAnalysis:
    """Classify every qubit in a circuit by its node type and relay bit.

    The relay bit r(q) = 1 iff qubit q appears as a CNOT target at time t
    and later as a CNOT control at time t' > t.

    This is the single binary property that determines fault isolation.
    """
    # Track first time each qubit is used as target and control
    first_target = {}   # qubit -> earliest time step as target
    first_control = {}  # qubit -> earliest time step as control
    all_targets = set()
    all_controls = set()

    for gate in sorted(gates, key=lambda g: g.time_step):
        c, t, ts = gate.control, gate.target, gate.time_step
        all_controls.add(c)
        all_targets.add(t)
        if c not in first_control:
            first_control[c] = ts
        if t not in first_target:
            first_target[t] = ts

    # Classify each qubit
    qubits = {}
    n_relays = 0

    for q in range(n_qubits):
        is_target = q in all_targets
        is_control = q in all_controls

        # Determine node type
        if not is_target and not is_control:
            node_type = NodeType.VIRGIN
        elif is_target and not is_control:
            node_type = NodeType.SPOKE
        elif is_control and not is_target:
            node_type = NodeType.HUB
        else:
            # Both target and control — check temporal order
            if first_target.get(q, float('inf')) < first_control.get(q, float('inf')):
                node_type = NodeType.RELAY
            else:
                # Control before target — hub that later receives
                # Still potentially a relay if it controls AFTER receiving
                # Check all gates for this qubit
                target_times = [g.time_step for g in gates if g.target == q]
                control_times = [g.time_step for g in gates if g.control == q]
                has_control_after_target = any(
                    ct > tt for tt in target_times for ct in control_times
                )
                if has_control_after_target:
                    node_type = NodeType.RELAY
                else:
                    node_type = NodeType.HUB  # Controls first, targeted later but never controls again

        # Compute relay bit
        relay_bit = 1 if node_type == NodeType.RELAY else 0
        if relay_bit:
            n_relays += 1

        qubits[q] = QubitInfo(
            index=q,
            node_type=node_type,
            relay_bit=relay_bit,
            first_target_time=first_target.get(q),
            first_control_time=first_control.get(q),
            fault_isolated=(relay_bit == 0),
        )

    # Generate warnings
    warnings = []
    for q, info in qubits.items():
        if info.node_type == NodeType.RELAY:
            warnings.append(
                f"q{q} is a RELAY (target at t={info.first_target_time}, "
                f"control at t={info.first_control_time}). "
                f"Errors on q{q} will propagate to downstream targets."
            )

    return TopologyAnalysis(
        qubits=qubits,
        gates=gates,
        n_qubits=n_qubits,
        n_relays=n_relays,
        fully_isolated=(n_relays == 0),
        warnings=warnings,
    )


def star(hub: int, spokes: List[int], shift_hub: bool = True) -> 'CircuitPlan':
    """Create a star topology: hub controls all spokes.

    All spokes are Type S (fault-isolated).
    Hub is Type H (control-only).
    No relays.

    Args:
        hub: Index of the hub qubit.
        spokes: Indices of spoke qubits.
        shift_hub: Whether to apply Hadamard to hub first.
    """
    return CircuitPlan('star', hub=hub, spokes=spokes, shift_hub=shift_hub)


def chain(qubits: List[int], shift_first: bool = True) -> 'CircuitPlan':
    """Create a chain topology: q[0] → q[1] → q[2] → ...

    All intermediate qubits are Type R (relays).
    Only q[0] (hub) and q[-1] (final target) are safe.

    Args:
        qubits: Ordered list of qubit indices.
        shift_first: Whether to apply Hadamard to first qubit.
    """
    return CircuitPlan('chain', chain_qubits=qubits, shift_first=shift_first)


def dual_hub(hubs: List[int], spokes: List[int],
             shift_hubs: bool = True) -> 'CircuitPlan':
    """Create a dual-hub topology: multiple hubs, all control-only.

    Every qubit is either Type H or Type S. No relays.
    Total fault isolation across all node pairs.

    Args:
        hubs: Indices of hub qubits (all will be control-only).
        spokes: Indices of spoke qubits (all will be target-only).
        shift_hubs: Whether to apply Hadamard to all hubs.
    """
    return CircuitPlan('dual_hub', hubs=hubs, spokes=spokes, shift_hubs=shift_hubs)


@dataclass
class CircuitPlan:
    """A planned circuit topology, ready to compile to Qiskit."""
    topology_type: str
    hub: Optional[int] = None
    spokes: Optional[List[int]] = None
    chain_qubits: Optional[List[int]] = None
    hubs: Optional[List[int]] = None
    shift_hub: bool = True
    shift_first: bool = True
    shift_hubs: bool = True

    @property
    def n_qubits(self) -> int:
        if self.topology_type == 'star':
            return max(self.spokes + [self.hub]) + 1
        elif self.topology_type == 'chain':
            return max(self.chain_qubits) + 1
        elif self.topology_type == 'dual_hub':
            return max(self.hubs + self.spokes) + 1
        return 0

    def gates(self) -> List[GateRecord]:
        """Generate the gate sequence for this topology."""
        result = []
        t = 0

        if self.topology_type == 'star':
            for spoke in self.spokes:
                result.append(GateRecord(self.hub, spoke, t, f"star({self.hub}→{spoke})"))
                t += 1

        elif self.topology_type == 'chain':
            for i in range(len(self.chain_qubits) - 1):
                c, targ = self.chain_qubits[i], self.chain_qubits[i + 1]
                result.append(GateRecord(c, targ, t, f"chain({c}→{targ})"))
                t += 1

        elif self.topology_type == 'dual_hub':
            for hub in self.hubs:
                for spoke in self.spokes:
                    result.append(GateRecord(hub, spoke, t, f"dual({hub}→{spoke})"))
                    t += 1

        return result

    def analyze(self) -> TopologyAnalysis:
        """Classify all nodes and check for relays."""
        return classify_circuit(self.gates(), self.n_qubits)

    def fidelity_cost(self, alpha: float = np.pi / 4) -> Optional[float]:
        """For chain topologies, compute F = cos⁴(α) at given middleman load."""
        if self.topology_type == 'chain' and len(self.chain_qubits) >= 3:
            return float(np.cos(alpha) ** 4)
        return None

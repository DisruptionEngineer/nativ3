"""
Nativ3: Topology-Aware Quantum Circuit Compiler
=================================================

A notation system and compiler for quantum circuits where
topology is the primitive, not the gate.

Usage:
    from nativ3 import star, chain, dual_hub, compile

    # Build a star topology — all spokes fault-isolated
    plan = star(hub=0, spokes=[1, 2, 3])
    result = compile(plan)
    print(result.report())

    # Build a chain — WARNING: has relay qubits
    plan = chain([0, 1, 2, 3])
    result = compile(plan)
    print(result.report())  # Shows relay warnings

    # Build a dual-hub — total fault isolation
    plan = dual_hub(hubs=[0, 4], spokes=[1, 2, 3])
    result = compile(plan)
    print(result.report())

Three Theorems (DOI: 10.5281/zenodo.19210676):
    1. Star ≠ chain for non-trivial middleman states
    2. F(star, chain) = cos⁴(α), independent of opening gate
    3. Star provides exact fault isolation under any TPCP channel

The Relay-Bit Principle:
    A qubit propagates errors iff it serves as a CNOT control
    after serving as a target. This single binary property
    determines the entire fault structure of a circuit.
"""

__version__ = "0.1.0"

from .topology import (
    star,
    chain,
    dual_hub,
    NodeType,
    CircuitPlan,
    TopologyAnalysis,
    QubitInfo,
    classify_circuit,
)

from .compiler import (
    compile,
    analyze_tradeoff,
    scan_relays,
    simulate,
    CompileResult,
)

from .scanner import (
    scan_circuit,
    scan_qasm,
    scan_gates,
    scan_with_costs,
    estimate_relay_loads,
    ScanResult,
)

__all__ = [
    'star', 'chain', 'dual_hub',
    'compile', 'analyze_tradeoff', 'scan_relays', 'simulate',
    'scan_circuit', 'scan_qasm', 'scan_gates',
    'NodeType', 'CircuitPlan', 'TopologyAnalysis', 'QubitInfo',
    'CompileResult', 'ScanResult', 'classify_circuit',
]

# Conditionally export transpiler passes when Qiskit is available
try:
    from .transpiler import RelayAnalysisPass, RelayEliminationPass
    __all__ += ['RelayAnalysisPass', 'RelayEliminationPass']
except ImportError:
    pass

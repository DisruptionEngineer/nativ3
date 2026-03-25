"""
Nativ3 Compiler Test Suite
============================
Verifies node classification, relay detection, fault isolation,
and the three theorems computationally.
"""

import numpy as np
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nativ3 import (
    star, chain, dual_hub, compile, analyze_tradeoff,
    NodeType, classify_circuit,
)
from nativ3.topology import GateRecord


def test_star_classification():
    """Star topology: hub is Type H, all spokes are Type S, no relays."""
    plan = star(hub=0, spokes=[1, 2, 3])
    analysis = plan.analyze()

    assert analysis.qubits[0].node_type == NodeType.HUB, "Hub should be Type H"
    for s in [1, 2, 3]:
        assert analysis.qubits[s].node_type == NodeType.SPOKE, f"Spoke {s} should be Type S"
    assert analysis.n_relays == 0, "Star should have no relays"
    assert analysis.fully_isolated, "Star should be fully isolated"
    print("  ✓ Star classification correct")


def test_chain_classification():
    """Chain topology: first qubit is hub, intermediates are relays, last is spoke."""
    plan = chain([0, 1, 2, 3])
    analysis = plan.analyze()

    assert analysis.qubits[0].node_type == NodeType.HUB, "First should be hub"
    assert analysis.qubits[1].node_type == NodeType.RELAY, "q1 should be relay"
    assert analysis.qubits[2].node_type == NodeType.RELAY, "q2 should be relay"
    assert analysis.qubits[3].node_type == NodeType.SPOKE, "Last should be spoke"
    assert analysis.n_relays == 2, "Chain of 4 should have 2 relays"
    assert not analysis.fully_isolated, "Chain should NOT be fully isolated"
    print("  ✓ Chain classification correct")


def test_dual_hub_classification():
    """Dual-hub: both hubs are Type H, all spokes Type S, no relays."""
    plan = dual_hub(hubs=[0, 4], spokes=[1, 2, 3])
    analysis = plan.analyze()

    assert analysis.qubits[0].node_type == NodeType.HUB
    assert analysis.qubits[4].node_type == NodeType.HUB
    for s in [1, 2, 3]:
        assert analysis.qubits[s].node_type == NodeType.SPOKE
    assert analysis.n_relays == 0
    assert analysis.fully_isolated
    print("  ✓ Dual-hub classification correct")


def test_relay_bit():
    """The relay bit is 1 iff qubit is target-then-control."""
    # Manual gate sequence: q0→q1 (q1 is target), q1→q2 (q1 is control)
    gates = [
        GateRecord(control=0, target=1, time_step=0),
        GateRecord(control=1, target=2, time_step=1),
    ]
    analysis = classify_circuit(gates, 3)

    assert analysis.qubits[0].relay_bit == 0, "q0 is control-only"
    assert analysis.qubits[1].relay_bit == 1, "q1 is target then control = RELAY"
    assert analysis.qubits[2].relay_bit == 0, "q2 is target-only"
    print("  ✓ Relay bit detection correct")


def test_compile_produces_circuit():
    """Compile should produce a Qiskit circuit if Qiskit is available."""
    plan = star(hub=0, spokes=[1, 2])
    result = compile(plan)

    if result.circuit is not None:
        assert result.circuit.num_qubits == 3
        print("  ✓ Qiskit circuit generated")
    else:
        print("  ⊘ Qiskit not installed, skipping circuit test")


def test_chain_warnings():
    """Chain compilation should produce relay warnings."""
    plan = chain([0, 1, 2])
    result = compile(plan)

    assert len(result.analysis.warnings) > 0, "Chain should have warnings"
    assert 'RELAY' in result.analysis.warnings[0]
    assert result.relay_count == 1
    print("  ✓ Chain relay warnings generated")


def test_tradeoff_analysis():
    """Tradeoff analysis should compute cos⁴(α) correctly."""
    plan = chain([0, 1, 2, 3])
    result = analyze_tradeoff(plan, alpha=np.pi / 4)

    expected_f = np.cos(np.pi / 4) ** 4
    assert abs(result['fidelity_cost'] - expected_f) < 1e-10
    assert result['relays_eliminated'] == 2
    assert 'STAR' in result['recommendation'] or 'CHAIN' in result['recommendation']
    print(f"  ✓ Tradeoff: F={result['fidelity_cost']:.4f}, recommendation generated")


def test_fidelity_formula():
    """Verify F = cos⁴(α) for star vs chain (Theorem 2)."""
    try:
        from nativ3.compiler import simulate
    except ImportError:
        print("  ⊘ Qiskit not available, skipping fidelity test")
        return

    for alpha in [0, np.pi/6, np.pi/4, np.pi/3, np.pi/2]:
        # Build circuits with middleman at angle alpha
        # This requires custom construction since star/chain assume |0⟩ init
        from qiskit import QuantumCircuit
        from qiskit.quantum_info import Statevector

        # Star
        qc_s = QuantumCircuit(3)
        qc_s.ry(2*alpha, 1)  # middleman = cos(α)|0⟩ + sin(α)|1⟩
        qc_s.h(0)
        qc_s.cx(0, 1)
        qc_s.cx(0, 2)

        # Chain
        qc_c = QuantumCircuit(3)
        qc_c.ry(2*alpha, 1)
        qc_c.h(0)
        qc_c.cx(0, 1)
        qc_c.cx(1, 2)

        sv_s = Statevector.from_instruction(qc_s)
        sv_c = Statevector.from_instruction(qc_c)
        fid = float(np.abs(sv_s.inner(sv_c)) ** 2)
        expected = np.cos(alpha) ** 4

        assert abs(fid - expected) < 1e-8, f"F={fid} != cos⁴({alpha})={expected}"

    print("  ✓ Theorem 2 (F = cos⁴α) verified at 5 points")


def test_star_commutativity():
    """Star gates from same hub should commute (order-independent)."""
    try:
        from qiskit import QuantumCircuit
        from qiskit.quantum_info import Statevector
    except ImportError:
        print("  ⊘ Qiskit not available, skipping commutativity test")
        return

    # Order A: 0→1, 0→2, 0→3
    qcA = QuantumCircuit(4)
    qcA.h(0)
    qcA.cx(0, 1); qcA.cx(0, 2); qcA.cx(0, 3)

    # Order B: 0→3, 0→1, 0→2
    qcB = QuantumCircuit(4)
    qcB.h(0)
    qcB.cx(0, 3); qcB.cx(0, 1); qcB.cx(0, 2)

    svA = Statevector.from_instruction(qcA)
    svB = Statevector.from_instruction(qcB)
    fid = float(np.abs(svA.inner(svB)) ** 2)

    assert abs(fid - 1.0) < 1e-10, f"Star gates should commute, F={fid}"
    print("  ✓ Star commutativity verified (order-independent)")


def test_report_output():
    """Reports should be readable strings."""
    for plan in [star(0, [1,2]), chain([0,1,2]), dual_hub([0,3], [1,2])]:
        result = compile(plan)
        report = result.report()
        assert isinstance(report, str)
        assert len(report) > 50
    print("  ✓ Reports generated for all topology types")


def main():
    print("=" * 55)
    print("  NATIV3 COMPILER TESTS")
    print("=" * 55)
    print()

    tests = [
        test_star_classification,
        test_chain_classification,
        test_dual_hub_classification,
        test_relay_bit,
        test_compile_produces_circuit,
        test_chain_warnings,
        test_tradeoff_analysis,
        test_fidelity_formula,
        test_star_commutativity,
        test_report_output,
    ]

    passed = 0
    failed = 0
    for test in tests:
        try:
            test()
            passed += 1
        except Exception as e:
            print(f"  ✗ {test.__name__}: {e}")
            failed += 1

    print(f"\n{'=' * 55}")
    print(f"  {passed} passed, {failed} failed, {len(tests)} total")
    print(f"{'=' * 55}")

    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())

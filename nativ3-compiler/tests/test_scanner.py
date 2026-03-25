"""
Nativ3 Scanner Tests
=====================
Tests the ability to analyze existing circuits for relay qubits.
"""

import numpy as np
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nativ3 import scan_gates, scan_qasm


def test_scan_gates_star():
    """Star topology from gate list should have zero relays."""
    result = scan_gates([(0,1), (0,2), (0,3)])
    assert result.relay_count == 0
    assert result.is_isolated
    assert result.cnot_count == 3
    print("  ✓ scan_gates: star detected as relay-free")


def test_scan_gates_chain():
    """Chain should detect relays."""
    result = scan_gates([(0,1), (1,2), (2,3)])
    assert result.relay_count == 2  # q1 and q2 are relays
    assert not result.is_isolated
    assert result.analysis.qubits[0].node_type.value == "hub"
    assert result.analysis.qubits[1].node_type.value == "relay"
    assert result.analysis.qubits[2].node_type.value == "relay"
    assert result.analysis.qubits[3].node_type.value == "spoke"
    print("  ✓ scan_gates: chain relays detected (q1, q2)")


def test_scan_gates_dual_hub():
    """Dual hub should be fully isolated."""
    result = scan_gates([(0,1), (0,2), (0,3), (4,1), (4,2), (4,3)])
    assert result.relay_count == 0
    assert result.is_isolated
    assert result.analysis.qubits[0].node_type.value == "hub"
    assert result.analysis.qubits[4].node_type.value == "hub"
    assert result.analysis.qubits[1].node_type.value == "spoke"
    print("  ✓ scan_gates: dual-hub detected as fully isolated")


def test_scan_gates_mixed():
    """Mixed topology: star from q0, then chain from q1."""
    # q0→q1, q0→q2, q1→q3  — q1 is a relay
    result = scan_gates([(0,1), (0,2), (1,3)])
    assert result.relay_count == 1
    assert result.analysis.qubits[1].node_type.value == "relay"
    assert result.analysis.qubits[2].node_type.value == "spoke"
    assert result.analysis.qubits[3].node_type.value == "spoke"
    print("  ✓ scan_gates: mixed topology, q1 relay detected")


def test_scan_gates_opportunities():
    """Chain should suggest star alternative."""
    result = scan_gates([(0,1), (1,2)])
    assert len(result.opportunities) > 0
    assert "star" in result.opportunities[0].description.lower() or \
           "relay" in result.opportunities[0].description.lower()
    print(f"  ✓ scan_gates: optimization found: {result.opportunities[0].description[:60]}...")


def test_scan_gates_konami():
    """Konami code topology should be fully isolated."""
    result = scan_gates([
        (0,2), (0,3), (1,2), (1,3), (0,4), (1,5)
    ])
    assert result.relay_count == 0
    assert result.is_isolated
    print("  ✓ scan_gates: konami code topology is fully isolated")


def test_scan_qasm_basic():
    """Parse a simple QASM circuit."""
    qasm = """
    OPENQASM 2.0;
    include "qelib1.inc";
    qreg q[4];
    h q[0];
    cx q[0], q[1];
    cx q[1], q[2];
    cx q[2], q[3];
    """
    result = scan_qasm(qasm)
    assert result.relay_count == 2
    assert not result.is_isolated
    assert result.cnot_count == 3
    print("  ✓ scan_qasm: chain detected from QASM string")


def test_scan_qasm_star():
    """Parse a star QASM circuit."""
    qasm = """
    OPENQASM 2.0;
    include "qelib1.inc";
    qreg q[4];
    h q[0];
    cx q[0], q[1];
    cx q[0], q[2];
    cx q[0], q[3];
    """
    result = scan_qasm(qasm)
    assert result.relay_count == 0
    assert result.is_isolated
    print("  ✓ scan_qasm: star detected from QASM string")


def test_scan_circuit_qiskit():
    """Scan a real Qiskit circuit."""
    try:
        from qiskit import QuantumCircuit
        from nativ3 import scan_circuit

        qc = QuantumCircuit(5, 5)
        qc.h(0)
        qc.cx(0, 1)
        qc.cx(1, 2)
        qc.cx(2, 3)
        qc.cx(0, 4)
        qc.measure(range(5), range(5))

        result = scan_circuit(qc)
        # q1 is relay (target of 0, control of 2)
        # q2 is relay (target of 1, control of 3)
        # q4 is spoke (only target of 0)
        assert result.analysis.qubits[1].node_type.value == "relay"
        assert result.analysis.qubits[2].node_type.value == "relay"
        assert result.analysis.qubits[4].node_type.value == "spoke"
        assert result.relay_count == 2
        assert result.depth is not None
        print(f"  ✓ scan_circuit: Qiskit circuit scanned, {result.relay_count} relays, depth {result.depth}")

    except ImportError:
        print("  ⊘ Qiskit not installed, skipping Qiskit circuit scan test")


def test_scan_circuit_ghz():
    """GHZ circuit (star from center) should be relay-free."""
    try:
        from qiskit import QuantumCircuit
        from nativ3 import scan_circuit

        # IBM's "better" GHZ: hub in the center
        qc = QuantumCircuit(5)
        qc.h(2)
        qc.cx(2, 1)
        qc.cx(2, 3)
        qc.cx(1, 0)  # This makes q1 a relay!
        qc.cx(3, 4)  # This makes q3 a relay!

        result = scan_circuit(qc)
        assert result.analysis.qubits[1].node_type.value == "relay"
        assert result.analysis.qubits[3].node_type.value == "relay"
        print(f"  ✓ scan_circuit: IBM GHZ has relays at q1, q3 (tree, not pure star)")
        print(f"    Compact: {result.report_compact()}")

    except ImportError:
        print("  ⊘ Qiskit not installed, skipping GHZ scan test")


def test_report_output():
    """Reports should be readable."""
    result = scan_gates([(0,1), (1,2), (2,3)])
    report = result.report()
    assert "RELAY" in report
    assert "PROPAGATES" in report
    compact = result.report_compact()
    assert "relay" in compact
    print(f"  ✓ Reports generated")
    print(f"    Compact: {compact}")


def test_relay_chain_detection():
    """Should find connected relay chains."""
    result = scan_gates([(0,1), (1,2), (2,3), (3,4)])
    # q1, q2, q3 are relays forming a chain
    assert len(result.relay_chains) > 0
    longest = max(result.relay_chains, key=lambda c: c.length)
    assert longest.length >= 3
    print(f"  ✓ Relay chain detected: {longest.description}")


def main():
    print("=" * 55)
    print("  NATIV3 SCANNER TESTS")
    print("=" * 55)
    print()

    tests = [
        test_scan_gates_star,
        test_scan_gates_chain,
        test_scan_gates_dual_hub,
        test_scan_gates_mixed,
        test_scan_gates_opportunities,
        test_scan_gates_konami,
        test_scan_qasm_basic,
        test_scan_qasm_star,
        test_scan_circuit_qiskit,
        test_scan_circuit_ghz,
        test_report_output,
        test_relay_chain_detection,
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

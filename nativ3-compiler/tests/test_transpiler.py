"""
Tests for Nativ3 Qiskit Transpiler Plugin
==========================================
Tests RelayAnalysisPass and RelayEliminationPass as standalone
passes and within a PassManager pipeline.
"""

import pytest
import numpy as np

try:
    from qiskit import QuantumCircuit
    from qiskit.transpiler import PassManager
    from qiskit.quantum_info import Statevector
    HAS_QISKIT = True
except ImportError:
    HAS_QISKIT = False

pytestmark = pytest.mark.skipif(not HAS_QISKIT, reason="Qiskit not installed")


@pytest.fixture
def star_circuit():
    """Star topology: q0 controls q1, q2, q3. No relays."""
    qc = QuantumCircuit(4)
    qc.h(0)
    qc.cx(0, 1)
    qc.cx(0, 2)
    qc.cx(0, 3)
    return qc


@pytest.fixture
def chain_circuit():
    """Chain topology: q0→q1→q2→q3. q1, q2 are relays."""
    qc = QuantumCircuit(4)
    qc.h(0)
    qc.cx(0, 1)
    qc.cx(1, 2)
    qc.cx(2, 3)
    return qc


@pytest.fixture
def ghz_circuit():
    """Standard GHZ-4 circuit (chain pattern)."""
    qc = QuantumCircuit(4)
    qc.h(0)
    qc.cx(0, 1)
    qc.cx(1, 2)
    qc.cx(2, 3)
    return qc


class TestRelayAnalysisPass:
    """Test the analysis pass annotates property_set correctly."""

    def test_star_no_relays(self, star_circuit):
        from nativ3.transpiler import RelayAnalysisPass
        pm = PassManager([RelayAnalysisPass()])
        pm.run(star_circuit)
        props = pm.property_set
        assert props['nativ3_isolated'] is True
        assert props['nativ3_relays'] == set()
        assert props['nativ3_topology'].n_relays == 0

    def test_chain_has_relays(self, chain_circuit):
        from nativ3.transpiler import RelayAnalysisPass
        pm = PassManager([RelayAnalysisPass()])
        pm.run(chain_circuit)
        props = pm.property_set
        assert props['nativ3_isolated'] is False
        assert props['nativ3_relays'] == {1, 2}
        assert props['nativ3_topology'].n_relays == 2

    def test_summary_string(self, chain_circuit):
        from nativ3.transpiler import RelayAnalysisPass
        pm = PassManager([RelayAnalysisPass()])
        pm.run(chain_circuit)
        summary = pm.property_set['nativ3_summary']
        assert 'relay' in summary.lower() or 'RELAY' in summary

    def test_analysis_doesnt_modify_circuit(self, chain_circuit):
        from nativ3.transpiler import RelayAnalysisPass
        original_ops = chain_circuit.count_ops()
        pm = PassManager([RelayAnalysisPass()])
        result = pm.run(chain_circuit)
        assert result.count_ops() == original_ops

    def test_empty_circuit(self):
        from nativ3.transpiler import RelayAnalysisPass
        qc = QuantumCircuit(3)
        pm = PassManager([RelayAnalysisPass()])
        pm.run(qc)
        assert pm.property_set['nativ3_isolated'] is True
        assert pm.property_set['nativ3_relays'] == set()

    def test_single_cx(self):
        from nativ3.transpiler import RelayAnalysisPass
        qc = QuantumCircuit(2)
        qc.cx(0, 1)
        pm = PassManager([RelayAnalysisPass()])
        pm.run(qc)
        assert pm.property_set['nativ3_isolated'] is True
        assert pm.property_set['nativ3_relays'] == set()


class TestRelayEliminationPass:
    """Test the transformation pass rewrites chains to stars."""

    def test_chain_rewrite(self, chain_circuit):
        from nativ3.transpiler import RelayAnalysisPass, RelayEliminationPass
        pm = PassManager([
            RelayAnalysisPass(),
            RelayEliminationPass(max_fidelity_loss=1.0),
        ])
        result = pm.run(chain_circuit)
        # After rewrite, should have fewer relays
        assert pm.property_set['nativ3_rewrites'] > 0

    def test_star_unchanged(self, star_circuit):
        from nativ3.transpiler import RelayAnalysisPass, RelayEliminationPass
        pm = PassManager([
            RelayAnalysisPass(),
            RelayEliminationPass(),
        ])
        result = pm.run(star_circuit)
        assert result.count_ops().get('cx', 0) == 3
        assert pm.property_set['nativ3_isolated'] is True

    def test_auto_analysis(self, chain_circuit):
        """RelayEliminationPass can run without prior analysis."""
        from nativ3.transpiler import RelayEliminationPass
        pm = PassManager([RelayEliminationPass(max_fidelity_loss=1.0)])
        result = pm.run(chain_circuit)
        # Should have run analysis internally
        assert 'nativ3_topology' in pm.property_set

    def test_fidelity_threshold(self, chain_circuit):
        """With max_fidelity_loss=0.0, no rewrites should happen."""
        from nativ3.transpiler import RelayAnalysisPass, RelayEliminationPass
        pm = PassManager([
            RelayAnalysisPass(),
            RelayEliminationPass(max_fidelity_loss=0.0),
        ])
        result = pm.run(chain_circuit)
        # No rewrites allowed at zero tolerance
        assert pm.property_set.get('nativ3_rewrites', 0) == 0


class TestPipeline:
    """Test full transpiler pipeline integration."""

    def test_passmanager_pipeline(self, chain_circuit):
        from nativ3.transpiler import RelayAnalysisPass, RelayEliminationPass
        pm = PassManager([
            RelayAnalysisPass(),
            RelayEliminationPass(max_fidelity_loss=1.0),
        ])
        result = pm.run(chain_circuit)
        assert isinstance(result, QuantumCircuit)
        assert result.num_qubits == 4

    def test_analysis_only_pipeline(self, ghz_circuit):
        from nativ3.transpiler import RelayAnalysisPass
        pm = PassManager([RelayAnalysisPass()])
        result = pm.run(ghz_circuit)
        assert pm.property_set['nativ3_relays'] == {1, 2}
        assert isinstance(result, QuantumCircuit)

# Nativ3

[![PyPI](https://img.shields.io/pypi/v/nativ3)](https://pypi.org/project/nativ3/)
[![Python](https://img.shields.io/pypi/pyversions/nativ3)](https://pypi.org/project/nativ3/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Topology-aware quantum circuit compiler with relay-bit fault isolation.**

Nativ3 treats circuit topology as the primitive, not the gate. It classifies every qubit by its role in the directed gate graph and provides exact fault isolation guarantees based on a single binary property: the **relay bit**.

> **Paper:** [DOI 10.5281/zenodo.19210676](https://doi.org/10.5281/zenodo.19210676)
> **Live IDE:** [nativ3.shift8.space](https://nativ3.shift8.space)

## The Relay-Bit Principle

A qubit propagates errors if and only if it serves as a CNOT control after serving as a target.

```
r(q) = 1  →  relay (target then control)  →  propagates errors
r(q) = 0  →  hub or spoke                 →  fault-isolated
```

## Install

```bash
pip install nativ3                 # core analysis (no Qiskit needed)
pip install nativ3[qiskit]         # with Qiskit circuit generation + transpiler plugin
```

## Quick Start

```python
from nativ3 import star, chain, dual_hub, compile

# Star topology — all spokes fault-isolated
result = compile(star(hub=0, spokes=[1, 2, 3]))
print(result.report())

# Chain topology — WARNING: has relay qubits
result = compile(chain([0, 1, 2, 3]))
print(result.report())
# ⚠ q1 is a RELAY (target at t=0, control at t=1)
# ⚠ q2 is a RELAY (target at t=1, control at t=2)

# Dual-hub — total fault isolation, no relays anywhere
result = compile(dual_hub(hubs=[0, 4], spokes=[1, 2, 3]))
print(result.report())
# ✓ fully fault-isolated
```

## Scan Existing Circuits

```python
from nativ3 import scan_circuit, scan_qasm, scan_gates

# Scan a bare gate list
result = scan_gates([(0,1), (1,2), (2,3)])
print(result.report())  # finds 2 relays, suggests star rewrite

# Scan OpenQASM (no Qiskit needed)
result = scan_qasm("""
    OPENQASM 2.0;
    include "qelib1.inc";
    qreg q[4];
    h q[0];
    cx q[0], q[1];
    cx q[1], q[2];
    cx q[2], q[3];
""")
print(result.report_compact())
# ⚠ 4q, 3 CNOTs, 2 relay(s), 1 chain(s)
```

## Qiskit Transpiler Plugin

Nativ3 registers two passes as Qiskit transpiler plugins, auto-discovered when installed:

```python
from qiskit import QuantumCircuit
from qiskit.transpiler import PassManager
from nativ3.transpiler import RelayAnalysisPass, RelayEliminationPass

# Build a chain circuit (has relays)
qc = QuantumCircuit(4)
qc.h(0)
qc.cx(0, 1)
qc.cx(1, 2)
qc.cx(2, 3)

# Analysis only — annotates property_set
pm = PassManager([RelayAnalysisPass()])
pm.run(qc)
print(pm.property_set['nativ3_relays'])    # {1, 2}
print(pm.property_set['nativ3_isolated'])  # False

# Analysis + elimination — rewrites chains to stars
pm = PassManager([
    RelayAnalysisPass(),
    RelayEliminationPass(max_fidelity_loss=0.5),
])
optimized = pm.run(qc)
```

### Transpiler Passes

| Pass | Type | Description |
|------|------|-------------|
| `RelayAnalysisPass` | `AnalysisPass` | Classifies qubits, sets `nativ3_topology`, `nativ3_relays`, `nativ3_isolated`, `nativ3_summary` in property_set |
| `RelayEliminationPass` | `TransformationPass` | Rewrites chain `(a→b, b→c)` to star `(a→b, a→c)`, eliminating relays. Configurable `max_fidelity_loss` threshold |

## Tradeoff Analysis

```python
from nativ3 import chain, analyze_tradeoff

tradeoff = analyze_tradeoff(chain([0, 1, 2, 3]), alpha=0.3)
print(tradeoff['recommendation'])
# RECOMMEND STAR: low fidelity cost (7.4%), eliminates 2 relay(s)
```

## Command Line

```bash
nativ3 star 0 1,2,3                    # star with hub=q0
nativ3 chain 0,1,2,3                   # chain (shows relay warnings)
nativ3 dual_hub 0,4 1,2,3              # dual-hub (total isolation)
nativ3 tradeoff 0,1,2,3 --alpha 0.5    # chain→star cost analysis
nativ3 compare 0,1,2                   # compare star vs chain states
nativ3 scan --gates 0:1,1:2,2:3        # scan arbitrary gate list
```

## Three Theorems

1. **Non-transitivity:** Star ≠ chain for non-trivial middleman states
2. **Fidelity formula:** F(star, chain) = cos⁴(α), independent of opening gate
3. **Fault isolation:** Star topologies exactly preserve hub-endpoint correlations under arbitrary TPCP noise on spoke qubits

## Node Types

| Type | Role | Relay Bit | Fault Behavior |
|------|------|-----------|----------------|
| Hub (H) | Control-only | 0 | Errors propagate TO targets |
| Spoke (S) | Target-only | 0 | Errors stay local — isolated |
| Relay (R) | Target→Control | 1 | Errors propagate downstream |

## License

MIT

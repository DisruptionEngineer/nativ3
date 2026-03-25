# Nativ3

**Topology-aware quantum circuit compiler with fault isolation analysis.**

Nativ3 treats circuit topology as the primitive, not the gate. It classifies every qubit by its role in the directed gate graph and provides exact fault isolation guarantees based on a single binary property: the **relay bit**.

## The Relay-Bit Principle

A qubit propagates errors if and only if it serves as a CNOT control after serving as a target.

```
r(q) = 1  →  relay (target then control)  →  propagates errors
r(q) = 0  →  hub or spoke                 →  fault-isolated
```

## Install

```bash
pip install -e .                    # core (analysis only, no Qiskit needed)
pip install -e ".[qiskit]"          # with Qiskit circuit generation
```

## Usage

### Python API

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

# Tradeoff analysis
from nativ3 import analyze_tradeoff
tradeoff = analyze_tradeoff(chain([0, 1, 2, 3]), alpha=0.3)
print(tradeoff['recommendation'])
```

### Command Line

```bash
nativ3 star 0 1,2,3                    # star with hub=q0
nativ3 chain 0,1,2,3                   # chain (shows relay warnings)
nativ3 dual_hub 0,4 1,2,3              # dual-hub (total isolation)
nativ3 tradeoff 0,1,2,3 --alpha 0.5    # chain→star cost analysis
nativ3 compare 0,1,2                   # compare star vs chain states
```

## Three Theorems

Based on the paper: [DOI 10.5281/zenodo.19210676](https://doi.org/10.5281/zenodo.19210676)

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

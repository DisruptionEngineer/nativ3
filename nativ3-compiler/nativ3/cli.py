"""
Nativ3 Command-Line Interface
===============================

Usage:
    nativ3 star 0 1,2,3              # star with hub=0, spokes=1,2,3
    nativ3 chain 0,1,2,3             # chain through qubits 0→1→2→3
    nativ3 dual_hub 0,4 1,2,3        # dual hubs, shared spokes
    nativ3 scan circuit.qasm         # scan existing circuit for relays
    nativ3 tradeoff 0,1,2,3 --alpha 0.5  # chain→star tradeoff analysis
"""

import sys
import numpy as np
from .topology import star, chain, dual_hub, GateRecord
from .compiler import compile, analyze_tradeoff, scan_relays


def parse_qubit_list(s: str) -> list:
    """Parse '1,2,3' into [1, 2, 3]."""
    return [int(x.strip()) for x in s.split(',')]


def cmd_star(args):
    hub = int(args[0])
    spokes = parse_qubit_list(args[1])
    plan = star(hub=hub, spokes=spokes)
    result = compile(plan)
    print(result.report())
    if result.circuit is not None:
        print(f"\n{result.circuit.draw()}")


def cmd_chain(args):
    qubits = parse_qubit_list(args[0])
    plan = chain(qubits)
    result = compile(plan)
    print(result.report())
    if result.circuit is not None:
        print(f"\n{result.circuit.draw()}")


def cmd_dual_hub(args):
    hubs = parse_qubit_list(args[0])
    spokes = parse_qubit_list(args[1])
    plan = dual_hub(hubs=hubs, spokes=spokes)
    result = compile(plan)
    print(result.report())
    if result.circuit is not None:
        print(f"\n{result.circuit.draw()}")


def cmd_tradeoff(args):
    qubits = parse_qubit_list(args[0])
    alpha = np.pi / 4  # default
    if '--alpha' in args:
        idx = args.index('--alpha')
        alpha = float(args[idx + 1])

    plan = chain(qubits)
    result = analyze_tradeoff(plan, alpha=alpha)

    print(f"\n{'═' * 55}")
    print(f"  TOPOLOGY TRADEOFF ANALYSIS")
    print(f"{'═' * 55}")
    print(f"\n  Chain: {' → '.join(f'q{q}' for q in qubits)}")
    print(f"  Middleman load: α = {alpha:.4f} ({alpha/np.pi:.3f}π)")
    print(f"\n  CHAIN:")
    print(result['chain_analysis'].summary())
    print(f"\n  STAR ALTERNATIVE:")
    print(result['star_analysis'].summary())
    print(f"\n  Fidelity cost:     F = {result['fidelity_cost']:.6f}")
    print(f"  Fidelity loss:     {result['fidelity_loss']:.1%}")
    print(f"  Relays eliminated: {result['relays_eliminated']}")
    print(f"\n  → {result['recommendation']}")
    print(f"{'═' * 55}")


def cmd_compare(args):
    """Compare star vs chain output states."""
    qubits = parse_qubit_list(args[0])
    hub = qubits[0]
    spokes = qubits[1:]

    from .compiler import simulate
    star_plan = star(hub=hub, spokes=spokes)
    chain_plan = chain(qubits)

    sv_star = simulate(star_plan)
    sv_chain = simulate(chain_plan)

    if sv_star is None:
        print("  Qiskit not installed. Install with: pip install qiskit")
        return

    fid = abs(np.dot(sv_star.conj(), sv_chain)) ** 2
    n = star_plan.n_qubits

    print(f"\n{'═' * 55}")
    print(f"  STAR vs CHAIN COMPARISON")
    print(f"{'═' * 55}")
    print(f"\n  Qubits: {qubits}")
    print(f"\n  Star state:")
    for i in range(2**n):
        if abs(sv_star[i]) > 1e-10:
            print(f"    {sv_star[i].real:+.4f} |{format(i, f'0{n}b')}⟩")
    print(f"\n  Chain state:")
    for i in range(2**n):
        if abs(sv_chain[i]) > 1e-10:
            print(f"    {sv_chain[i].real:+.4f} |{format(i, f'0{n}b')}⟩")
    print(f"\n  Fidelity: {fid:.6f}")
    print(f"  {'IDENTICAL' if fid > 0.999 else 'DIFFERENT'}")
    print(f"{'═' * 55}")


def cmd_scan(args):
    """Scan an existing circuit for relays."""
    from .scanner import scan_qasm, scan_gates

    if len(args) == 0:
        print("Usage:")
        print("  nativ3 scan <file.qasm>           # scan QASM file")
        print("  nativ3 scan --gates 0:1,1:2,2:3   # scan gate list (ctrl:targ pairs)")
        return

    if args[0] == '--gates':
        # Parse gate list: "0:1,1:2,2:3"
        pairs = []
        for pair in args[1].split(','):
            c, t = pair.split(':')
            pairs.append((int(c), int(t)))
        result = scan_gates(pairs)
        print(result.report())
    else:
        # Assume file path
        import os
        filepath = args[0]
        if not os.path.exists(filepath):
            print(f"  File not found: {filepath}")
            return
        with open(filepath) as f:
            qasm_str = f.read()
        result = scan_qasm(qasm_str)
        print(result.report())


def main():
    args = sys.argv[1:]

    if not args or args[0] in ('-h', '--help'):
        print(__doc__)
        print("Commands:")
        print("  star <hub> <spokes>        Build star topology")
        print("  chain <qubits>             Build chain topology")
        print("  dual_hub <hubs> <spokes>   Build dual-hub topology")
        print("  tradeoff <qubits> [--alpha val]  Analyze chain→star tradeoff")
        print("  compare <qubits>           Compare star vs chain states")
        return

    cmd = args[0]
    rest = args[1:]

    commands = {
        'star': cmd_star,
        'chain': cmd_chain,
        'dual_hub': cmd_dual_hub,
        'tradeoff': cmd_tradeoff,
        'compare': cmd_compare,
        'scan': cmd_scan,
    }

    if cmd in commands:
        commands[cmd](rest)
    else:
        print(f"Unknown command: {cmd}")
        print(f"Available: {', '.join(commands.keys())}")


if __name__ == '__main__':
    main()

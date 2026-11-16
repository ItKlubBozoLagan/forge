import sys

lines = sys.stdin.read().split("\n")
if len(lines) != 2 or lines[1] != "" or not lines[0].isdigit():
    sys.exit("expected a single integer and a newline")
if not N_MIN <= int(lines[0]) <= N_MAX:
    sys.exit(f"N={lines[0]} is outside [{N_MIN}, {N_MAX}]")

# The interactor receives the test on stdin, then one extra newline, then everything the
# solution prints. Read the solution's output token by token so blank lines do not matter.
# What it prints goes to the solution. Its verdict (AC, WA or custom:<score>) is written to
# interactor_meta.out. N_MAX and Q_MAX come from the constraints in problem.yaml.
import sys

def finish(verdict):
    with open("interactor_meta.out", "w") as meta:
        meta.write(verdict)
    sys.exit(0)

def tokens():
    for line in sys.stdin:
        yield from line.split()

reader = tokens()
secret = int(next(reader))
print(N_MAX, flush=True)
for _ in range(Q_MAX):
    token = next(reader, None)
    if token is None or not token.isdigit():
        finish("WA")
    guess = int(token)
    if guess == secret:
        print("=", flush=True)
        finish("AC")
    print("<" if secret < guess else ">", flush=True)
finish("WA")

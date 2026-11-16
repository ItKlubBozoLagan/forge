# Asks 1, 2, 3, ... and runs out of questions.
limit = int(input())
for guess in range(1, limit + 1):
    print(guess, flush=True)
    if input() == "=":
        break

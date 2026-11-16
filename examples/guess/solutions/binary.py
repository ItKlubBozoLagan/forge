low, high = 1, int(input())
while True:
    middle = (low + high) // 2
    print(middle, flush=True)
    answer = input()
    if answer == "=":
        break
    if answer == "<":
        high = middle - 1
    else:
        low = middle + 1

# Guess the Number

The judge has chosen a secret integer between $1$ and $N$. Find it with at most {{Q.max}}
questions.

## Interaction

First read $N$ ($N \le {{N.max}}$). Then repeatedly print a guess and flush. The judge answers
`<` when the secret is smaller than your guess, `>` when it is larger, and `=` when you found
it, after which your program must stop.

# Enforcement Gates

Mandatory checks before merge:
1. No hardcoded secrets
2. tsc --noEmit passes
3. Tests pass
4. No console.log
5. No SQL injection/XSS
6. File < 800 lines

## On Violation
Issue returns to todo with comment describing failure.

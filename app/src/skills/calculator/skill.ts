import { z } from "zod";

import { defineSkill } from "../define-skill";

const inputSchema = z
  .object({
    expression: z.string().trim().min(1).max(200),
  })
  .strict();

export function createCalculatorSkill() {
  return defineSkill({
    name: "calculator",
    description:
      'Evaluates a numeric arithmetic expression (+, -, *, /, %, ^, parentheses) and returns the result. Use this for any non-trivial arithmetic instead of computing it yourself.',
    inputDescription:
      '{"expression":"arithmetic expression, e.g. \\"(3 + 4) * 2 / 7\\""}',
    inputSchema,
    execution: { mutability: "read", impact: "normal" },
    configured: true,
    async execute(input) {
      try {
        const result = evaluateExpression(input.expression);
        return { success: true, data: { result } };
      } catch (error: unknown) {
        return {
          success: false,
          error: {
            code: "INVALID_EXPRESSION",
            message:
              error instanceof Error
                ? error.message
                : "The expression could not be evaluated.",
          },
        };
      }
    },
  });
}

/**
 * Safe recursive-descent arithmetic evaluator. No `eval`, no identifiers, no
 * function calls — only numeric literals and +, -, *, /, %, ^, parentheses.
 */
function evaluateExpression(expression: string): number {
  const tokens = tokenize(expression);
  const parser = new ArithmeticParser(tokens);
  const value = parser.parseExpression();
  parser.expectEnd();
  if (!Number.isFinite(value)) {
    throw new Error("The expression did not evaluate to a finite number.");
  }
  return value;
}

type Token =
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "op"; readonly value: string };

const TOKEN_PATTERN = /\s*(?:(\d+(?:\.\d+)?)|([+\-*/%^()]))\s*/y;

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    TOKEN_PATTERN.lastIndex = index;
    const match = TOKEN_PATTERN.exec(expression);
    if (!match || match.index !== index) {
      throw new Error(`Unexpected character at position ${index}.`);
    }
    if (match[1] !== undefined) {
      tokens.push({ type: "number", value: Number(match[1]) });
    } else if (match[2] !== undefined) {
      tokens.push({ type: "op", value: match[2] });
    }
    index = TOKEN_PATTERN.lastIndex;
  }
  return tokens;
}

class ArithmeticParser {
  private position = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parseExpression(): number {
    return this.parseAddSub();
  }

  expectEnd(): void {
    if (this.position < this.tokens.length) {
      throw new Error("Unexpected trailing input in expression.");
    }
  }

  private parseAddSub(): number {
    let value = this.parseMulDiv();
    while (this.peekOp("+") || this.peekOp("-")) {
      const op = this.next().value;
      const rhs = this.parseMulDiv();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  private parseMulDiv(): number {
    let value = this.parsePow();
    while (this.peekOp("*") || this.peekOp("/") || this.peekOp("%")) {
      const op = this.next().value;
      const rhs = this.parsePow();
      if (op === "*") {
        value *= rhs;
      } else if (op === "/") {
        if (rhs === 0) throw new Error("Division by zero.");
        value /= rhs;
      } else {
        if (rhs === 0) throw new Error("Division by zero.");
        value %= rhs;
      }
    }
    return value;
  }

  private parsePow(): number {
    const base = this.parseUnary();
    if (this.peekOp("^")) {
      this.next();
      const exponent = this.parsePow(); // right-associative
      return Math.pow(base, exponent);
    }
    return base;
  }

  private parseUnary(): number {
    if (this.peekOp("-")) {
      this.next();
      return -this.parseUnary();
    }
    if (this.peekOp("+")) {
      this.next();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.tokens[this.position];
    if (!token) throw new Error("Unexpected end of expression.");
    if (token.type === "number") {
      this.position += 1;
      return token.value;
    }
    if (token.type === "op" && token.value === "(") {
      this.position += 1;
      const value = this.parseAddSub();
      if (!this.peekOp(")")) throw new Error("Missing closing parenthesis.");
      this.next();
      return value;
    }
    throw new Error("Expected a number or parenthesis.");
  }

  private peekOp(value: string): boolean {
    const token = this.tokens[this.position];
    return token?.type === "op" && token.value === value;
  }

  private next(): Token {
    const token = this.tokens[this.position];
    if (!token) throw new Error("Unexpected end of expression.");
    this.position += 1;
    return token;
  }
}

import { describe, expect, it } from "vitest";
import { classifyExpression } from "./expression-classifier";

describe("classifyExpression", () => {
  describe("safe member paths", () => {
    it.each(["this", "productNumber", "this.Summary", "product.Supplier", "lines[0]", 'map["key"]', "$exception", "this._summaryReads"])(
      "should allow %s",
      (expression) => {
        expect(classifyExpression(expression)).toEqual({ isSafe: true });
      },
    );

    it("should allow known format specifiers", () => {
      expect(classifyExpression("this.Summary, nse")).toEqual({ isSafe: true });
      expect(classifyExpression("lines, nse, raw")).toEqual({ isSafe: true });
    });
  });

  describe("expressions that need approval", () => {
    it.each([
      ["this.Calculate(3)", "calls a method or uses a cast"],
      ["((OrderLine)x).Amount", "calls a method or uses a cast"],
      ["net = 0", "assigns a value"],
      ["count++", "increments or decrements a value"],
      ["new OrderLine()", "creates an object"],
      ["lines.Where(b => b.Amount > 0)", "contains a lambda"],
      ["a; b", "contains more than one statement"],
      ["Gross * 0.82", "is not a plain member path"],
    ])("should flag %s because it %s", (expression, reason) => {
      expect(classifyExpression(expression)).toEqual({ isSafe: false, reason });
    });

    it("should flag an unknown format specifier", () => {
      expect(classifyExpression("this.Summary, ac")).toEqual({
        isSafe: false,
        reason: "uses the format specifier 'ac'",
      });
    });

    it("should flag an empty expression", () => {
      expect(classifyExpression("  ")).toEqual({ isSafe: false, reason: "is empty" });
    });
  });

  it("should treat comparison as not an assignment", () => {
    expect(classifyExpression("a == b")).toEqual({ isSafe: false, reason: "is not a plain member path" });
  });
});

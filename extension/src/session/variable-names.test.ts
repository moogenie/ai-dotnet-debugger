import { describe, expect, it } from "vitest";
import { isLiteralValue, stripTypeSuffix, toForwardSlashes, truncate, withNse, withoutNse } from "./variable-names";

describe("stripTypeSuffix", () => {
  it("should remove the declared type vsdbg appends to a name", () => {
    expect(stripTypeSuffix("lines [IReadOnlyList]")).toBe("lines");
    expect(stripTypeSuffix("productNumber [int]")).toBe("productNumber");
  });

  it("should keep an index name and drop only its type", () => {
    expect(stripTypeSuffix("[0] [OrderLine]")).toBe("[0]");
    expect(stripTypeSuffix("[0]")).toBe("[0]");
  });

  it("should leave a plain name unchanged", () => {
    expect(stripTypeSuffix("this")).toBe("this");
    expect(stripTypeSuffix("Raw View")).toBe("Raw View");
  });
});

describe("withNse", () => {
  it("should append the no-side-effects specifier", () => {
    expect(withNse("this.Summary")).toBe("this.Summary, nse");
  });

  it("should not append it twice", () => {
    expect(withNse("this.Summary, nse")).toBe("this.Summary, nse");
    expect(withNse("lines, nse, raw")).toBe("lines, nse, raw");
  });

  it("should trim surrounding whitespace first", () => {
    expect(withNse("  productNumber ")).toBe("productNumber, nse");
  });
});

describe("truncate", () => {
  it("should flag and cut a value over the limit", () => {
    expect(truncate("abcdef", 3)).toEqual({ isTruncated: true, value: "abc" });
  });

  it("should leave a value within the limit unchanged", () => {
    expect(truncate("abc", 3)).toEqual({ isTruncated: false, value: "abc" });
  });
});

describe("toForwardSlashes", () => {
  it("should turn Windows separators into forward slashes", () => {
    expect(toForwardSlashes("fixtures\\SampleApp\\Domain\\Basket.cs")).toBe("fixtures/SampleApp/Domain/Basket.cs");
  });
});

describe("withoutNse", () => {
  it("should remove every nse specifier and keep others", () => {
    expect(withoutNse("this.Calculate(3), nse")).toBe("this.Calculate(3)");
    expect(withoutNse("lines, nse, raw")).toBe("lines, raw");
  });
});

describe("isLiteralValue", () => {
  it.each(["3", "-1.5", "1000.00", '"Basket"', "'c'", "true", "null", "{SampleApp.Domain.Basket}"])(
    "should treat %s as read from memory",
    (value) => {
      expect(isLiteralValue(value)).toBe(true);
    },
  );

  it.each(["Count = 5", "{OrderLine { ProductNumber = 3, Amount = 200.00 }}", ""])("should treat %s as computed", (value) => {
    expect(isLiteralValue(value)).toBe(false);
  });
});

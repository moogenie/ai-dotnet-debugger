import { describe, expect, it } from "vitest";
import { Redactor, luhnValid, parseAdditionalRules } from "./redaction";

// All values are synthetic test data.
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoiU3ludGhldGljIFRlc3QgVXNlciIsInN1YiI6InRlc3QtdXNlci0wMDAxIn0.c3ludGhldGljLXNpZ25hdHVyZS1ub3QtcmVhbA";

describe("Redactor", () => {
  const redactor = new Redactor();

  describe("built-in value rules", () => {
    it("should redact an email address", () => {
      expect(redactor.redactText("contact synthetic.user@example.com now")).toBe("contact [redacted:email] now");
    });

    it("should redact a Luhn-valid card number with or without separators", () => {
      expect(redactor.redactText("4111 1111 1111 1111")).toBe("[redacted:card-number]");
      expect(redactor.redactText("4111-1111-1111-1111")).toBe("[redacted:card-number]");
      expect(redactor.redactText("4111111111111111")).toBe("[redacted:card-number]");
    });

    it("should leave a long number that fails the Luhn check, and ordinary amounts", () => {
      expect(redactor.redactText("4111 1111 1111 1112")).toBe("4111 1111 1111 1112");
      expect(redactor.redactText("Basket: 5 lines, gross GBP 1200.00")).toBe("Basket: 5 lines, gross GBP 1200.00");
    });

    it("should redact a JWT", () => {
      expect(redactor.redactText(`"${JWT}"`)).toBe('"[redacted:jwt]"');
    });

    it("should redact connection-string credentials and keep the rest", () => {
      const text = "Server=localhost;Database=SampleTest;User ID=sample_user;Password=NotARealPassword1;";
      expect(redactor.redactText(text)).toBe(
        "Server=localhost;Database=SampleTest;[redacted:connection-string];[redacted:connection-string];",
      );
    });

    it("should redact bearer tokens, AWS access keys and private key blocks", () => {
      expect(redactor.redactText("Authorization: Bearer abc.def-ghi")).not.toContain("abc.def-ghi");
      expect(redactor.redactText("key AKIAABCDEFGHIJKLMNOP")).toBe("key [redacted:aws-access-key]");
      const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIsynthetic\n-----END RSA PRIVATE KEY-----";
      expect(redactor.redactText(pem)).toBe("[redacted:private-key]");
    });

    it("should redact a sensitive assignment inside a record's display string", () => {
      const display = '{TestCredentials { ApiToken = tok_test_9f8e7d6c5b4a39281706, Label = synthetic }}';
      const result = redactor.redactText(display);
      expect(result).not.toContain("tok_test_9f8e7d6c5b4a39281706");
      expect(result).toContain("Label = synthetic");
    });
  });

  describe("built-in name rule", () => {
    it("should redact the value of a member with a sensitive name", () => {
      const { counts, value } = redactor.redact({ name: "ApiToken", value: '"tok_test_9f8e7d6c5b4a39281706"' });
      expect(value).toEqual({ name: "ApiToken", value: "[redacted:name]" });
      expect(counts.name).toBe(1);
    });

    it("should leave an ordinary member alone", () => {
      expect(redactor.redact({ name: "Label", value: '"synthetic"' }).value).toEqual({
        name: "Label",
        value: '"synthetic"',
      });
    });
  });

  describe("payload walk", () => {
    it("should redact nested strings, keep the structure and count each rule", () => {
      const payload = {
        locals: [{ children: [{ name: "ContactEmail", value: '"synthetic.user@example.com"' }], name: "c", value: "{}" }],
        outputTail: ["sent to synthetic.user@example.com"],
        stopId: 3,
      };
      const { counts, value } = redactor.redact(payload);
      expect(value.stopId).toBe(3);
      expect(value.locals[0]?.children[0]?.value).toBe('"[redacted:email]"');
      expect(value.outputTail).toEqual(["sent to [redacted:email]"]);
      expect(counts.email).toBe(2);
    });

    it("should not change the input object", () => {
      const payload = { value: "synthetic.user@example.com" };
      redactor.redact(payload);
      expect(payload.value).toBe("synthetic.user@example.com");
    });
  });

  describe("additional rules", () => {
    it("should add a custom rule on top of the built-ins", () => {
      const { rules } = parseAdditionalRules([{ name: "ticket", pattern: "CUST-\\d+" }]);
      const custom = new Redactor(rules);
      expect(custom.redactText("CUST-1234 for synthetic.user@example.com")).toBe(
        "[redacted:custom:ticket] for [redacted:email]",
      );
    });

    it("should ignore an invalid rule and report it", () => {
      const parsed = parseAdditionalRules([{ name: "broken", pattern: "(" }, { name: "empty", pattern: "" }, {}]);
      expect(parsed.rules).toEqual([]);
      expect(parsed.invalid).toEqual(["broken", "empty", "custom"]);
    });

    it("should never let a setting turn a built-in rule off", () => {
      const { rules } = parseAdditionalRules([{ name: "email", pattern: "" }, { name: "email", pattern: "^$" }]);
      expect(new Redactor(rules).redactText("synthetic.user@example.com")).toBe("[redacted:email]");
    });
  });
});

describe("luhnValid", () => {
  it("should accept the Visa test number and reject a changed digit", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
  });
});

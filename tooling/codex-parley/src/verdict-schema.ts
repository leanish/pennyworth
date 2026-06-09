export const verdictJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "reason", "body"],
  properties: {
    status: {
      type: "string",
      enum: ["agree", "disagree", "needs-user", "error"],
    },
    summary: {
      type: "string",
      minLength: 1,
    },
    reason: {
      type: "string",
      minLength: 1,
    },
    body: {
      type: "string",
      minLength: 1,
    },
  },
} as const;

export const verdictJsonSchemaString = JSON.stringify(verdictJsonSchema);

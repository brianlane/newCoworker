import { describe, expect, it } from "vitest";
import {
  MAX_TODO_DETAILS_LENGTH,
  MAX_TODO_TITLE_LENGTH,
  buildTodoAssignmentSms,
  formatTodoDueAt,
  isTodoOverdue,
  todoCompletionStamps,
  todoCreateSchema,
  todoListFilterSchema,
  todoPatchSchema
} from "@/lib/todos/core";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("todoCreateSchema", () => {
  it("accepts a minimal body and a full body", () => {
    expect(todoCreateSchema.parse({ title: "  Call Sam  " })).toEqual({
      title: "Call Sam"
    });
    expect(
      todoCreateSchema.parse({
        title: "Send packet",
        details: "  the disclosure packet  ",
        contactId: UUID,
        dealId: UUID,
        assigneeEmployeeId: UUID,
        dueAt: "2026-08-25T21:00:00.000Z"
      })
    ).toEqual({
      title: "Send packet",
      details: "the disclosure packet",
      contactId: UUID,
      dealId: UUID,
      assigneeEmployeeId: UUID,
      dueAt: "2026-08-25T21:00:00.000Z"
    });
  });

  it("normalizes trimmed-empty details to null and keeps explicit null", () => {
    expect(todoCreateSchema.parse({ title: "x", details: "   " }).details).toBeNull();
    expect(todoCreateSchema.parse({ title: "x", details: null }).details).toBeNull();
  });

  it("enforces the caps, the datetime shape, and strict keys", () => {
    expect(() =>
      todoCreateSchema.parse({ title: "x".repeat(MAX_TODO_TITLE_LENGTH + 1) })
    ).toThrow();
    expect(() =>
      todoCreateSchema.parse({ title: "x", details: "y".repeat(MAX_TODO_DETAILS_LENGTH + 1) })
    ).toThrow();
    expect(() => todoCreateSchema.parse({ title: "" })).toThrow();
    expect(() => todoCreateSchema.parse({ title: "x", dueAt: "tomorrow" })).toThrow();
    expect(() => todoCreateSchema.parse({ title: "x", assignee: UUID })).toThrow();
  });
});

describe("todoPatchSchema", () => {
  it("accepts any non-empty subset and refuses an empty patch", () => {
    expect(todoPatchSchema.parse({ completed: true })).toEqual({ completed: true });
    expect(todoPatchSchema.parse({ dueAt: null, assigneeEmployeeId: null })).toEqual({
      dueAt: null,
      assigneeEmployeeId: null
    });
    expect(() => todoPatchSchema.parse({})).toThrow("Nothing to update.");
    expect(() => todoPatchSchema.parse({ bogus: 1 })).toThrow();
  });
});

describe("todoListFilterSchema", () => {
  it("parses the three statuses plus the assignee, all optional", () => {
    expect(todoListFilterSchema.parse({})).toEqual({});
    expect(
      todoListFilterSchema.parse({ status: "overdue", assigneeEmployeeId: UUID })
    ).toEqual({ status: "overdue", assigneeEmployeeId: UUID });
    expect(() => todoListFilterSchema.parse({ status: "late" })).toThrow();
  });
});

describe("isTodoOverdue", () => {
  const now = new Date("2026-08-20T12:00:00.000Z");

  it("is true only for a past due date on an uncompleted to-do", () => {
    expect(isTodoOverdue({ dueAt: "2026-08-20T11:59:59.000Z", completedAt: null }, now)).toBe(
      true
    );
    expect(isTodoOverdue({ dueAt: "2026-08-20T12:00:01.000Z", completedAt: null }, now)).toBe(
      false
    );
  });

  it("no due date, a completed stamp, or an unparseable due are never overdue", () => {
    expect(isTodoOverdue({ dueAt: null, completedAt: null }, now)).toBe(false);
    expect(
      isTodoOverdue(
        { dueAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-08-01T00:00:00.000Z" },
        now
      )
    ).toBe(false);
    expect(isTodoOverdue({ dueAt: "not a date", completedAt: null }, now)).toBe(false);
  });

  it("defaults `now` to the clock", () => {
    expect(isTodoOverdue({ dueAt: "2000-01-01T00:00:00.000Z", completedAt: null })).toBe(true);
  });
});

describe("todoCompletionStamps", () => {
  it("checking off stamps the pair; unchecking clears both", () => {
    expect(todoCompletionStamps(true, "2026-08-20T12:00:00.000Z", "user-1")).toEqual({
      completed_at: "2026-08-20T12:00:00.000Z",
      completed_by: "user-1"
    });
    expect(todoCompletionStamps(false, "2026-08-20T12:00:00.000Z", "user-1")).toEqual({
      completed_at: null,
      completed_by: null
    });
  });
});

describe("formatTodoDueAt", () => {
  const now = new Date("2026-08-20T12:00:00.000Z");

  it("renders in the given timezone, falling back to UTC for null", () => {
    // 21:00Z is 2:00 PM in Phoenix (UTC-7, no DST).
    expect(formatTodoDueAt("2026-08-25T21:00:00.000Z", "America/Phoenix", now)).toBe(
      "Tue, Aug 25, 2:00 PM"
    );
    expect(formatTodoDueAt("2026-08-25T21:00:00.000Z", null, now)).toBe("Tue, Aug 25, 9:00 PM");
  });

  it("appends the year only when it differs from the current one", () => {
    expect(formatTodoDueAt("2027-01-05T00:30:00.000Z", null, now)).toContain("2027");
    expect(formatTodoDueAt("2026-08-25T21:00:00.000Z", null, now)).not.toContain("2026");
  });

  it("null in null out, unparseable in null out, bad timezone falls back to UTC", () => {
    expect(formatTodoDueAt(null, "America/Phoenix", now)).toBeNull();
    expect(formatTodoDueAt("nope", "America/Phoenix", now)).toBeNull();
    expect(formatTodoDueAt("2026-08-25T21:00:00.000Z", "Not/AZone", now)).toBe(
      "Tue, Aug 25, 9:00 PM"
    );
  });
});

describe("buildTodoAssignmentSms", () => {
  it("is one concise message naming the title, plus the due date when set", () => {
    expect(
      buildTodoAssignmentSms({ title: "Send the packet", dueLabel: "Tue, Aug 25, 2:00 PM" })
    ).toBe('New Coworker: you were assigned a to-do: "Send the packet". Due Tue, Aug 25, 2:00 PM.');
    expect(buildTodoAssignmentSms({ title: "Send the packet", dueLabel: null })).toBe(
      'New Coworker: you were assigned a to-do: "Send the packet".'
    );
  });
});

---
name: feedback-lex-dont-guess-string-edges
description: "For codemods over source, ask the TS parser for string spans; neighbouring characters cannot tell an opening quote from a closing one"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 050a9946-fd28-4872-aa0f-a6ece9fc1d42
  modified: 2026-08-19T00:57:05.677Z
---

When writing a codemod that rewrites text inside source files, decide "is this
position at the edge of a string?" from the TypeScript parser, not from the
neighbouring character.

**Why:** during the em dash sweep ([[project-em-dash-sweep-complete]]) I first
guessed edges from the adjacent character. It silently mangled two whole
classes:

- `` `page "${name}" \u2014 done` `` reads the `"` before the dash as a string
  START, so the dash became a list marker: `"${name}"- done`.
- A dash after `${...}` sits at the start of a template CHUNK, which looks like
  the start of a string but is mid-sentence.

Guessing also cannot see that a lone `\u2014` inside quotes is a whole-string
placeholder while `" \u2014 "` is a separator: both have quotes on each side.

**How to apply:** `ts.createSourceFile(..., /*setParentNodes*/ true,
ScriptKind.TSX)`, then collect spans for `StringLiteral`,
`NoSubstitutionTemplateLiteral`, `TemplateHead/Middle/Tail`, and `JsxText`, and
tag each span with whether its start and end are REAL edges of the copy
(`TemplateMiddle` is neither; `TemplateTail` closes but does not open). Treat a
newline inside a span as an edge too. For comments, use
`getLeadingCommentRanges` over the node walk, and add `JsxExpression` nodes with
no expression, since `{/* ... */}` is not trivia of any token.

Also: a hand-rolled lexer is not a shortcut here. An apostrophe in JSX text
("It's fine") reads as a string opener and desyncs everything after it.

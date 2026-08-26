---
name: unicode-escapes-in-tool-json
description: Typing \u0000-style escapes in Write/Edit content decodes to the literal control character in the file; Read renders it invisibly and Edit then cannot match
metadata:
  type: feedback
---

Writing `"\u0000"` inside Write/Edit tool content lands a LITERAL NUL byte in
the file, not the six-character escape sequence: the escape decodes at the
tool-JSON layer before reaching disk. Read then renders the byte invisibly
(the line looks like `join(" ")`), so a follow-up Edit whose old_string has a
plain space reports "not found", and grep may go silent because it treats the
NUL-bearing file as binary.

**Why:** tool parameters travel as JSON strings; JSON escape decoding happens
once before the file write, so source code that should CONTAIN an escape
sequence gets the decoded character instead.

**How to apply:** when a source file needs a visible escape sequence (\u0000,
\x00, \n inside a string literal), do not type the escape in Write/Edit
content. Write a placeholder and convert with perl afterward
(`perl -i -pe 's/\x00/\\u0000/g' file`), or double the backslash. Verify
suspicious content with `cat -v` or `od -c`; Read output proves nothing about
control characters.

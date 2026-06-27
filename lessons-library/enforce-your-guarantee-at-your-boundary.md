# Enforce your guarantee at your own boundary

**Trigger:** You depend on an upstream contract for safety (redaction, sanitization, auth, audit) at the point where you emit output or take action.

**Failure mode:** Trusting that "someone upstream already handled it" leaves gaps: secrets leak because redaction happened earlier and not here; partial sanitization (named entities but not numeric) is bypassable; open redirects; missing audit rows on failure paths; hiding content behind permission checks that the client can ignore.

**Correct behavior:**
- Redact at YOUR boundary; don't trust an upstream's redaction contract.
- Sanitize/decode to a fixed point, covering BOTH named and numeric entity forms.
- Validate user-supplied redirect URLs against an allowlist before use.
- Emit audit rows on EVERY path — success AND failure.
- Gate controls/affordances by permission; never gate sensitive content by hiding the control alone.

**Check:** If every upstream guarantee were removed, would your boundary still be safe on its own?

**Seen in:** recurring across multiple production projects.

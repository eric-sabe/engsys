# Tests can assert the bug

**Trigger:** You root-caused a bug, but a test is green over exactly that code path.

**Failure mode:** A test that contradicts a confirmed bug is asserting the buggy behavior, or isn't exercising real behavior at all. Mocks looser than reality and docstrings that claim coverage create false confidence — the green is the lie, not the bug report.

**Correct behavior:**
- Treat a green test that contradicts a root cause as a suspect to investigate, not as proof you're wrong.
- Check whether mocks are looser than production reality, and whether the assertion actually pins the behavior.
- Fix behavior and test together in one commit.
- Add an integration-level test that would fail on the real bug.

**Check:** Does a test now fail when you reintroduce the original bug? If not, it never covered it.

**Seen in:** recurring across multiple production projects.

# Aevistle 0.1.12

One fix, on the exact symptom 0.1.11 was meant to clear.

0.1.11 made the working calendar's "check online" button work — 2025 and 2026
now fetch their real tables. **2027 still answered with a sentence that read
like a defect.**

The upstream feed commits a placeholder for the coming year the moment the file
exists — `{"year": 2027, "days": []}`, served as a perfectly good HTTP 200 —
months before the State Council publishes the notice that fills it. Aevistle
read that as an unreadable file and said so, in English, inside a Chinese
interface: *"无法获取 2027 年：no usable dates in the file"*.

It now says what is actually true, in your own language, and in the same words
the row already uses before you press the button: **2027 年尚未公布**. It is
reported as information rather than as an error, because nothing failed.

A year whose file is genuinely unreadable is still reported as a problem — the
guard now asserts both directions, and was checked against the pre-fix
behaviour to confirm it can fail.

# App Store Connect fields: limits and the rules that bite

Every limit below counts **characters, including spaces**. Measure, never eyeball
— `scripts/audit_release.py` reports the real count for each field.

| Field            | Limit | Editable without a new build? | Indexed for search? |
| ---------------- | ----- | ----------------------------- | ------------------- |
| App name         | 30    | No                            | Yes (strongest)     |
| Subtitle         | 30    | No                            | Yes (strong)        |
| Keywords         | 100   | No                            | Yes                 |
| Promotional text | 170   | **Yes**                       | No                  |
| Description      | 4000  | No                            | No                  |
| What's New       | 4000  | No (tied to the version)      | No                  |
| Marketing URL    | 255   | **Yes**                       | No                  |
| Support URL      | 255   | **Yes**                       | No                  |
| Privacy URL      | 255   | No                            | No                  |

A character is a **UTF-16 code unit**, not a code point: an emoji costs 2, a CJK
character costs 1, and a flag emoji can cost 4. This is why a description that
"looks like" 3,999 gets rejected at 4,002. Every limit is also **per locale**, and
`apply_listing` refuses the whole push if any one locale is over.

Two of these are scoped differently from the rest, which matters when you push:
**name, subtitle and privacy URL belong to the app**, not to a version, so editing
them changes the live listing immediately rather than riding along with the next
submission. The other six are version-scoped.

"Editable without a new build" is the lever most people miss. Promotional text is
the only field you can change any time — so anything time-sensitive (a launch, a
price change, a seasonal hook) belongs there, not buried in the description where
changing it costs you a whole submission.

## Description

The one that quietly overflows. A mature listing is usually already at 3,700–3,900
of its 4,000, so **adding a feature means taking something out**. Budget before you
write: measure the current field, subtract, and know how many characters you are
actually shopping with. Discovering you are 1,300 over after writing is how you end
up hacking good copy to pieces.

Not indexed for search, so keyword-stuffing it does nothing. Write it for a human
deciding whether to click Get.

## Keywords

100 characters, comma-separated, and the rules all exist to stop you wasting them:

- **No space after the commas.** `a, b` costs one more character than `a,b` and buys
  exactly nothing.
- **Singular only.** Apple stems plurals — `bucket` already matches `buckets`.
- **Never repeat the app name or subtitle.** Those fields are already indexed;
  repeating a word here spends characters to buy a match you already had.
- **Apple matches across fields.** `cloud` + `storage` as separate keywords already
  covers the phrase "cloud storage", so spelling out multi-word phrases is often
  waste. Prefer distinct single terms unless the phrase is a real search query.
- **Third-party trademarks are a review risk.** Naming competitors or services you
  merely interoperate with (`backblaze`, `wasabi`, `dropbox`) can draw a rejection
  under the metadata guidelines. Descriptive use of a platform you genuinely
  integrate with (an R2 client naming `cloudflare`) is the defensible case. This is
  a judgment call with real upside on both sides — surface it to the user rather
  than deciding silently. A metadata rejection is fixable without a new binary, so
  the downside is annoyance, not a resubmission.

## Subtitle

30 characters, under the app name, and indexed nearly as strongly as the name. Do
not waste it restating the name. It should add a _different_ set of searchable
words plus a reason to care. "Storage manager for R2 & S3" beats "The best R2 app".

## What's New

Per-version release notes. Users skim the first line and stop, so lead with the
single headline change and let the rest be a short bulleted tail. Do not paste the
whole changelog — the changelog is for developers, this is for customers.

Keep it consistent with the changelog's release-notes block if the project keeps
one, since they are two renderings of the same release.

## Promotional text

170 characters, shown above the description, **and changeable at any time without a
submission**. Use it for whatever is true _right now_ — the newest feature, a sale,
a launch. Because it is free to change, it should rarely be a stale restatement of
the app's evergreen pitch; that is the description's job.

## Review-risk notes

- Don't name competitors in any field (see keywords above).
- Don't reference other platforms ("also on Android") — a common rejection.
- Don't mention prices in the description if they vary by storefront; a hardcoded
  "$4.99" is wrong for most of the world. Let StoreKit render the localized price
  in-app, and keep the number out of copy where you can.
- Screenshots must show the actual app. Marketing frames and captions around a real
  capture are fine; a mockup that isn't the app is not.

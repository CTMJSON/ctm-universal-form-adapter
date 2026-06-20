# CTM Universal Form Adapter

A universal Lambda function for [CTM](https://calltrackingmetrics.com) that parses webhook payloads from virtually any form vendor and normalizes them into the CTM Form Reactor format — no per-customer configuration required.

## What It Does

When a web form is submitted, most form vendors POST a webhook to a URL you specify. The problem is that every vendor structures that payload differently. This Lambda sits between the form vendor and CTM, translating any incoming webhook into the standard fields CTM needs (`caller_name`, `email`, `phone_number`, `callback_number`, `country_code`, `visitor_sid`, `custom_fields`).

**Natively recognized vendors:**

| Vendor | Detection Method |
|---|---|
| Zoho Forms | `phone_number` key + `Field_N` pattern |
| JotForm | `rawRequest` field (requires JSON webhook config — see note below) |
| Tally | `data.fields[]` array with typed fields |
| Formidable Forms | `fields` object + `item_id` key |
| Fluent Forms | `inputs` object (resolves nested `names.first_name/last_name`) |
| WPForms | `fields` object + `meta` object |
| Gravity Forms | `form_id` + `date_created` + numeric top-level keys |
| Elementor Forms | `form_fields` object |
| Typeform | `form_response.answers[]` with definition mapping |
| GoHighLevel | `type: "FormSubmission"` + `contact` object |
| Facebook / Meta Lead Ads | `object: "page"` + `entry[].changes[].value.field_data[]` |
| HubSpot | Form submission `{submittedAt, data: [{name,value}]}` or contact webhook `[{properties:{}}]` |
| **Any other JSON vendor** | Generic fallback: scans all keys and values for phone, email, and name patterns |

Even for unrecognized vendors, the parser scans field names and values to match phone numbers, email addresses, and names automatically. Any JSON webhook with a phone number in it should produce a valid CTM activity.

---

## Setup

### Step 1 — Create the Lambda in CTM

1. Log in to [CTM](https://app.calltrackingmetrics.com) and go to your account.
2. Navigate to **Account → Integrations → Lambda Functions**.
   - Direct link: `https://app.calltrackingmetrics.com/accounts/YOUR_ACCOUNT_ID/lambdas`
   - Full setup guide: [CTM Lambda Functions](https://calltrackingmetrics.zendesk.com/hc/en-us/articles/6603700875661-CTM-Lambda-Functions)
3. Click **New Lambda Function**.
4. Give it a descriptive name, e.g. `Universal Inbound Form Parser`.
5. Paste the entire contents of [`lambda.js`](lambda.js) into the code editor.
6. Click **Save**.

> No environment variables or external dependencies are required. The function runs entirely on the built-in Node.js runtime.

---

### Step 2 — Create a Form Reactor

A Form Reactor is the CTM construct that receives a webhook POST and routes it to a tracking number. You need one per form (or one shared reactor if all your forms go to the same number).

1. Navigate to **Account → Integrations → Form Reactors**.
   - Full setup guide: [CTM Form Reactors](https://calltrackingmetrics.zendesk.com/hc/en-us/articles/6423010132877-Click-to-Call-Form-FormReactors)
2. Click **New Form Reactor**.
3. Configure:
   - **Name** — something identifiable, e.g. `Contact Page Form`
   - **Tracking Number** — the CTM number that will receive calls/texts triggered by this form
   - **Inbound Form Parser** — select the Lambda you created in Step 1
4. Click **Save**.

---

### Step 3 — Copy the Form Reactor POST URL

After saving, CTM generates a unique POST endpoint for this reactor. It looks like:

```
https://app.calltrackingmetrics.com/api/v1/accounts/ACCOUNT_ID/form_reactors/REACTOR_ID/submit?key=UNIQUE_KEY
```

Copy this URL — this is where your form vendor will send its webhook.

> The key embedded in the URL authenticates the request. Keep it private and do not commit it to source control.

---

### Step 4 — Configure Your Form Vendor's Webhook

Paste the Form Reactor POST URL as the webhook destination in your form tool.

**Vendor-specific notes:**

- **JotForm** — By default JotForm sends `multipart/form-data`, which CTM cannot parse. In your JotForm webhook settings, enable **"Send as JSON"** (or set the content type to `application/json`). Without this, the Lambda will receive an empty body. JotForm also wraps field keys in curly braces (`{name}`, `{phoneNumber12}`) — the parser strips these automatically before pattern matching.
- **Facebook / Meta Lead Ads** — You must set up the webhook through Meta's developer portal and subscribe to `leadgen` events. The Form Reactor URL is your callback endpoint.
- **Typeform** — In the Typeform webhook settings, enable **"Include response"** to include answer data in the payload.
- **GoHighLevel** — Use the form's **"Webhook"** action in the workflow builder. Select `POST` and paste the Form Reactor URL.
- **All others** — Paste the URL directly into the vendor's webhook or notification URL field. No additional configuration is required.

---

## How the Parser Works

```
Incoming webhook POST
        │
        ▼
  parseBody()          ← unwraps CTM's event.options.request_body envelope;
                          falls back to event.body, event.request_body, or raw event
        │
        ▼
  normalizeBody()      ← detects vendor by payload shape; flattens nested structures
                          into {key: value} pairs with semantic keys
        │
        ▼
  sanitizeKeys()       ← strips {braces} from vendor field names (e.g. JotForm)
                          so pattern matching works regardless of key format
        │
        ▼
  Key-pattern scan     ← matches caller_name, first/last name, email, phone, and
                          visitor_sid by field label keywords
        │
        ▼
  Value fallback scan  ← if key patterns miss, scans all values for phone/email shape
        │
        ▼
  custom_fields build  ← every remaining non-noise field → custom_{key}
                          promoted SID fields suppressed; key collisions get _2, _3 suffix
        │
        ▼
  context.done(null, payload)
```

**Output format:**

```json
{
  "phone_number": "4435551234",
  "callback_number": "+14435551234",
  "country_code": "1",
  "caller_name": "Jane Doe",
  "email": "jane@example.com",
  "visitor_sid": "67bf826f00002dfe4f6c5d06",
  "custom_fields": {
    "custom_message": "I need a quote",
    "custom_company": "Acme Corp"
  }
}
```

`visitor_sid` is only included when a valid SID is found in the payload.

---

## Phone Number Handling

| Input | phone_number | callback_number | country_code |
|---|---|---|---|
| `4435551234` | `4435551234` | `+14435551234` | `1` |
| `14435551234` | `4435551234` | `+14435551234` | `1` |
| `+14435551234` | `4435551234` | `+14435551234` | `1` |
| `+447911123456` (UK) | `447911123456` | `+447911123456` | *(blank)* |
| `+525512345678` (MX) | `525512345678` | `+525512345678` | *(blank)* |

US numbers are fully normalized. International numbers are passed through rather than dropped.

---

## Visitor SID Extraction

If the form payload includes a CTM visitor/session SID — typically injected as a hidden field by the CTM tracking script on your website — the Lambda extracts it and returns it as `visitor_sid`. This links the form submission to the CTM visitor session that was already tracked before the form was filled out, enabling full attribution.

### Simple website example

Add a hidden field to your form:

```html
<input type="hidden" name="visitor_sid" id="your_hidden_field_id" value="">
```

Then populate it after the CTM tracking script loads:

```html
<script>
window.__ctm_loaded = window.__ctm_loaded || [];
window.__ctm_loaded.push(function () {
  var field = document.getElementById("your_hidden_field_id");
  if (
    field &&
    window.__ctm &&
    __ctm.config &&
    __ctm.config.sid
  ) {
    field.value = __ctm.config.sid;
  }
});
</script>
```

**Recognized key names** (case-insensitive):

| Key | Notes |
|---|---|
| `visitor_sid` | Canonical CTM field name |
| `sid` | Short alias |
| `ctm_visitor_sid` | Explicit CTM prefix |
| `ctm_session_id` | Session ID variant |
| `ctm_sid` | Short CTM variant |
| `session_id` | Generic session key |
| `visitor_id` / `visitorId` | Visitor ID variant |
| `tracking_sid` | Tracking alias |
| Any key containing `sid` + `ctm`, `visitor`, `session`, or `tracking` | Compound match |

**Validation:** values must be exactly 24 lowercase hex characters (e.g. `67bf826f00002dfe4f6c5d06`). This is the format CTM uses for all session/visitor IDs.

**False positive prevention:** generic ID fields like `submission_id`, `entry_id`, and `form_id` are intentionally excluded. A 24-character hex value is only promoted to `visitor_sid` if the key name signals CTM/session/visitor intent — preventing MongoDB ObjectIds or other vendor IDs from being misidentified.

**Deduplication:** once promoted to top-level `visitor_sid`, the field is suppressed from `custom_fields` so it does not also appear as `custom_visitor_sid`.

---

## Noise Filtering

Fields that would pollute CTM activity logs are automatically suppressed:

- Internal form metadata (`form_id`, `submission_id`, `ip`, `timestamp`, `slug`, etc.)
- Vendor-specific system fields (`rawRequest`, `jsExecutionTracker`, `uploadServerUrl`, etc.)
- Values longer than 400 characters
- JotForm-style serialized PHP arrays (`key=>value` patterns)
- Thank-you page redirect URLs
- Known CDN/API URLs from Tally, JotForm, and Zoho

---

## Error Handling

If the Lambda throws for any reason, CTM receives a structured error response rather than silence:

```json
{
  "phone_number": "",
  "callback_number": "",
  "country_code": "1",
  "custom_fields": {
    "custom_parse_error": "Cannot read property 'length' of undefined"
  }
}
```

This means the activity is still logged in CTM and the error is visible in the activity's custom fields, making debugging straightforward without access to CloudWatch.

---

## Files

```
lambda.js   — The Lambda function to paste into CTM's code editor
README.md   — This file
```

---

## License

MIT

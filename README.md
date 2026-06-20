# CTM Universal Form Adapter

A serverless Lambda function that acts as a universal webhook adapter between **any form vendor** and [CallTrackingMetrics (CTM) FormReactor](https://calltrackingmetrics.com/formreactor).

Point any form vendor's webhook at this Lambda, and it will normalize the payload into the format CTM's FormReactor API expects — then forward it to:

```
POST https://api.calltrackingmetrics.com/api/v1/formreactor/{{unique_form_id}}
```

---

## Built-In Vendor Support

The following form vendors have dedicated payload normalization logic:

| Vendor | Detection Method |
|---|---|
| **Facebook / Meta Lead Ads** | `object: "page"` with `entry[].changes[].value.field_data` |
| **GoHighLevel** | `type: "FormSubmission"` with `contact` and `customField` objects |
| **Elementor** | `form_fields` object |
| **Typeform** | `form_response.answers` array with field definitions |
| **Tally** | `data.fields` array with label/type/value entries |
| **WPForms** | `fields` object alongside `meta` object |
| **JotForm** | `rawRequest` JSON string merged into body |
| **Zoho Forms** | `phone_number` key alongside `Field_N` generic keys |

### Generic Fallback

Any vendor not listed above will still work as long as the webhook sends a **JSON** or **URL-encoded** payload. The adapter will:

1. Parse the body from `event.body`, `event.request_body`, or `event.options.request_body`
2. Attempt to extract name, email, and phone by scanning key names for common patterns (`phone`, `email`, `name`, `first_name`, etc.)
3. Fall back to heuristic detection — scanning all values for anything that looks like a phone number or email address
4. Pass remaining fields through as `custom_fields`

---

## How It Works

```
Form Vendor Webhook
        |
        v
  Lambda Function
        |
        |  1. Parse body (JSON or URL-encoded)
        |  2. Detect vendor and normalize payload
        |  3. Extract: name, phone, email
        |  4. Collect remaining fields as custom_fields
        |  5. Strip noise (metadata, internal URLs, timestamps)
        |
        v
  CTM FormReactor API
  POST /api/v1/formreactor/{id}
```

### Output Payload

The Lambda produces a CTM-compatible payload:

```json
{
  "phone_number": "5551234567",
  "callback_number": "+15551234567",
  "country_code": "1",
  "caller_name": "Jane Doe",
  "email": "jane@example.com",
  "custom_fields": {
    "custom_company": "Acme Inc",
    "custom_message": "I need a quote"
  }
}
```

---

## Setup

### 1. Deploy the Lambda

Upload `index.js` as an AWS Lambda function (Node.js runtime). The handler is `index.handler`.

No external dependencies required — this is pure vanilla JavaScript.

### 2. Configure Your Form Vendor

Set the webhook URL of your form vendor to point to your Lambda's invoke URL (e.g., via API Gateway).

### 3. Configure CTM FormReactor

In CTM, set up a FormReactor and use the **REST API Form Submission** (managed mode) option. The Lambda output should be POSTed to:

```
https://api.calltrackingmetrics.com/api/v1/formreactor/{your_unique_form_id}
```

You can chain the Lambda output directly to CTM via API Gateway integration, or have the Lambda itself make the POST to CTM after normalization (modify the handler to add an HTTP call before `context.done`).

### 4. Lambda as Middleware (Recommended)

The cleanest architecture is to use the Lambda as a middleware step:

```
Form Vendor --> API Gateway --> Lambda --> CTM FormReactor API
```

Modify the handler to make the outbound POST to CTM if you want the Lambda to handle the full chain.

---

## Phone Number Handling

- Strips all non-digit characters
- Handles 10-digit US numbers and 11-digit numbers with leading `1`
- Outputs `phone_number` as local 10-digit format
- Outputs `callback_number` as E.164 format (`+1XXXXXXXXXX`)
- Handles split phone objects (e.g., `{area: "555", phone: "1234567"}`)

---

## Noise Filtering

The adapter automatically strips out vendor-specific metadata that shouldn't appear in CTM's call log, including:

- Internal vendor IDs, timestamps, and execution trackers
- Server URLs and webhook URLs
- Long raw payloads (>400 chars)
- Submission metadata (PDF URLs, preview URLs, etc.)

---

## Requirements

- **Runtime:** Node.js (any version — no modern syntax used)
- **Dependencies:** None
- **Plans:** CTM Growth, Connect, or higher (FormReactor API access required)
- **Limits:** CTM allows up to 1,000 unique API-based FormReactors per account on Growth/Connect plans, 100 on Performance plans

---

## License

MIT

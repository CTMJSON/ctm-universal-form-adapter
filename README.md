# CTM Universal Form Adapter

A universal Lambda function for [CTM](https://calltrackingmetrics.com) that parses webhook payloads from virtually any form vendor and normalizes them into the CTM Form Reactor format — no per-customer configuration required.

## What It Does

When a web form is submitted, most form vendors POST a webhook to a URL you specify. The problem is that every vendor structures that payload differently. This Lambda sits between the form vendor and CTM, translating any incoming webhook into the standard fields CTM needs (`caller_name`, `email`, `phone_number`, `callback_number`, `country_code`, `visitor_sid`, `custom_fields`).

**Natively recognized vendors:**

| Vendor | Detection Method | Notes for CTM Form Reactor |
|---|---|---|
| [ActiveCampaign](https://developers.activecampaign.com/reference/create-a-webhook) | `contact` object with `{email, first_name, last_name, phone}` | Best fit if setting up via API/dev docs. For UI-based automations, ActiveCampaign's automation webhook action may be more relevant. |
| [ClickFunnels](https://developers.myclickfunnels.com/docs/webhooks) | `event.type` + `data.funnel_id` (data suppressed in generic path) | Select **JSON** as the adapter in ClickFunnels webhook settings — not "Form Data." |
| [Contact Form 7](https://cf7apps.com/docs/integration/webhook/) | `fields` object + `page_url` or `submission_date` (intercepted before WPForms false-positive) | Requires a webhook plugin (CF7 Apps or RT Webhook for CF7). Set content type to `application/json`. The default `your-{fieldname}` prefix is stripped automatically. |
| [Cognito Forms](https://www.cognitoforms.com/support/69/entries/webhooks) | `Fields` object + `DateSubmitted` key (PascalCase keys handled automatically) | Use the CTM Form Reactor URL as the webhook endpoint. |
| [Elementor Forms](https://elementor.com/help/webhook-form-action/) | `form_fields` object | Elementor Pro Forms: "Actions After Submit → Webhook." |
| [Facebook / Meta Lead Ads](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/instant-forms/webhooks/) | `object: "page"` + `entry[].changes[].value.field_data[]` | Requires Meta app/webhook setup. Subscribe to `leadgen` events. |
| [FormAssembly](https://help.formassembly.com/help/webhook-connector](https://help.formassembly.com/help/webhook-connector)) | `form_data` object with semantic field keys | Best article for posting submission data to an external endpoint. |
| [Formaloo](https://help.formaloo.com/en/articles/5561274-webhooks) | `readable_data` object or `rendered_data` array (both formats handled) | Both payload formats are detected and handled automatically. |
| [Formidable Forms](https://formidableforms.com/knowledgebase/form-actions/#api-webhooks) | `fields` object + `item_id` key | Configured as a form action in Formidable. |
| [Formstack](https://help.formstack.com/hc/en-us/articles/360019520251-Webhooks) | `fields` object of `{label, value}` descriptors + `Form` object (capital F) | Use the CTM Form Reactor URL as the webhook endpoint. |
| [Fluent Forms](https://fluentforms.com/docs/fluent-forms-webhook/) | `inputs` object (resolves nested `names.first_name/last_name`) | Use this for configuring POST to the CTM Form Reactor URL. |
| [GoFormz](https://support.goformz.com/hc/en-us/articles/360045747812-Webhooks) | `Data.Fields` object + `Event` key (PascalCase envelope) | Add a Webhook action in GoFormz Workflows. Name template fields semantically (e.g. `CustomerPhone`, `ContactEmail`) — a field named `Field_23` will not be recognized. |
| [GoHighLevel](https://help.gohighlevel.com/support/solutions/articles/155000001108-workflow-action-webhook) | `type: "FormSubmission"` + `contact` object | Use the "Webhook" workflow action. Select `POST` and paste the Form Reactor URL. |
| [Gravity Forms](https://docs.gravityforms.com/webhooks-add-on/) | `form_id` + `date_created` + numeric top-level keys | Requires the Gravity Forms Webhooks Add-On. |
| [Housecall Pro](https://docs.housecallpro.com/docs/housecall-public-api/46e9e1be07621-webhooks) | `event` string + `data.customer` object (data suppressed in generic path) | Requires MAX plan; activate via the Housecall Pro App Store. Invoice total, balance due, job number, job status, arrival window, and assigned tech are included as custom fields. |
| [HubSpot](https://knowledge.hubspot.com/workflows/how-do-i-use-webhooks-with-hubspot-workflows) | Form submission `{submittedAt, data: [{name,value}]}` or contact webhook `[{properties:{}}]` | Best UI-oriented article if sending form/contact data from workflows. |
| [JotForm](https://www.jotform.com/help/27-how-to-setup-webhooks/) | `rawRequest` field | **Enable "Send as JSON"** in JotForm webhook settings. Without it, CTM receives `multipart/form-data` and the Lambda sees an empty body. |
| [Klaviyo](https://developers.klaviyo.com/en/docs/webhooks) | `data.attributes` object (JSON:API envelope; `custom_properties` inlined) | Developer docs are the best fit; payload is JSON:API-style. |
| [Pipedrive](https://pipedrive.readme.io/docs/guide-for-webhooks) | `current` + `meta.action` envelope; contact from `current.person_id` (deal) or `current` (person) | Subscribe to `added.deal` or `added.person` events. Company name and deal title are included as custom fields. |
| [Process Street](https://www.process.st/help/docs/webhooks/) | `data.formFields` object (field keys are user-defined in the workflow) | Best article for pushing workflow/form field data to CTM. |
| [ServiceTitan](https://help.servicetitan.com/docs/set-up-scheduling-pro-webhooks) | `Event` object + `Data.Customer` (PascalCase; `Data` suppressed in generic path) | Job number, status, total revenue, and assigned technician are included as custom fields. |
| [Tally](https://tally.so/help/webhooks) | `data.fields[]` array with typed fields | Paste the CTM Form Reactor URL as the webhook endpoint. |
| [Typeform](https://www.typeform.com/help/a/webhooks-360029573471/) | `form_response.answers[]` with definition mapping | Enable **"Include response"** so the Lambda receives `form_response.answers[]`. |
| [WPForms](https://wpforms.com/docs/how-to-use-the-webhooks-addon-with-wpforms/) | `fields` object + `meta` object | Requires WPForms Pro with the Webhooks addon. |
| [WooCommerce](https://developer.woocommerce.com/docs/best-practices/urls-and-routing/webhooks/) | `billing` object + `order_key` (order webhook); `first_name` + `email` at top level (customer webhook — works without hardening) | In WooCommerce go to **Settings → Advanced → Webhooks**. Use the `order.created` topic to capture new purchases. Contact details are extracted from the billing address. |
| [Wufoo](https://help.wufoo.com/articles/en_US/SurveyMonkeyArticleType/Webhooks) | `MachineName` key; maps `FieldNLabel` → value when field structures included | Enable **"Include Field and Form Structures with Entry Data"** to add `FieldNLabel` companion keys. Without it, name capture falls back to value scanning and may be incomplete. |
| [Zoho Forms](https://help.zoho.com/portal/en/kb/forms/user-guide/form-settings/webhooks/articles/webhooks) | `phone_number` key + `Field_N` pattern | Use the CTM Form Reactor URL as the webhook endpoint. |
| **Any other JSON vendor** | Generic fallback: scans all keys and values for phone, email, and name patterns | Paste the Form Reactor URL directly into the vendor's webhook or notification URL field. |

Even for unrecognized vendors, the parser scans field names and values to match phone numbers, email addresses, and names automatically. Any JSON webhook with a phone number in it should produce a valid CTM activity.

---

## Setup

### Step 1 — Create the Lambda in CTM

1. Log in to [CTM](https://app.calltrackingmetrics.com) and go to your account.
2. Navigate to **Flows → Lambdas from the left Nav**.
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

1. Navigate to **Flows → FormReactor from the left Nav**.
   - Full setup guide: [CTM Form Reactors](https://calltrackingmetrics.zendesk.com/hc/en-us/articles/6423010132877-Click-to-Call-Form-FormReactors)
2. Click **New Form Reactor**.
3. Configure:
   - **Name** — something identifiable, e.g. `Contact Page Form`
   - **Tracking Number** — the CTM number that will receive calls/texts triggered by this form
   - **Inbound Form Parser** — select the Lambda you created in Step 1
     <img width="1623" height="335" alt="Screenshot 2026-06-20 at 7 08 00 AM" src="https://github.com/user-attachments/assets/a690dd5a-8a60-4ed4-aebb-9a827673ec06" />

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

Paste the Form Reactor POST URL as the webhook destination in your form tool. Vendor-specific setup links and CTM notes are in the table at the top of this page.

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

## Request an Integration

This is an experimental tool maintained by [jason.smith@ctm.com](mailto:jason.smith@ctm.com). If your form vendor isn't on the list, you can request support in two ways:

- **[Fill out the integration request form](https://docs.google.com/forms/d/e/1FAIpQLSdFpDNkZY_HYoNOCqYhQxz3Ke2qsQZ-i0Tu7nHEK24uwT2WYw/viewform)** — the more detail you provide (webhook docs link, example JSON payload), the faster we can add support.
- **Email** [jason.smith@ctm.com](mailto:jason.smith@ctm.com) directly with questions.

**Before submitting, use [webhook.site](https://webhook.site) to capture your vendor's exact payload.** Point your form or automation at a webhook.site URL, submit a test entry, and paste the raw JSON you receive into the request form. This is the single most useful thing you can provide — it lets us build and test the handler without needing access to your account.

---

## Files

```
lambda.js   — The Lambda function to paste into CTM's code editor
README.md   — This file
```

---

## License

MIT

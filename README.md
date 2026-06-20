# CTM Universal Form Adapter

A universal Lambda function for [CTM](https://calltrackingmetrics.com) that parses webhook payloads from virtually any form vendor and normalizes them into the CTM Form Reactor format — no per-customer configuration required.

## What It Does

When a web form is submitted, most form vendors POST a webhook to a URL you specify. The problem is that every vendor structures that payload differently.

This Lambda sits between the form vendor and CTM, translating incoming webhook payloads into the standard fields CTM needs:

- `caller_name`
- `email`
- `phone_number`
- `callback_number`
- `country_code`
- `visitor_sid`
- `custom_fields`

## Natively Recognized Vendors

| Vendor | Detection Method |
|---|---|
| Zoho Forms | `phone_number` key + `Field_N` pattern |
| JotForm | `rawRequest` field; requires JSON webhook config |
| Tally | `data.fields[]` array with typed fields |
| WPForms | `fields` object + `meta` object |
| Gravity Forms | `form_id` + `date_created` + numeric top-level keys |
| Elementor Forms | `form_fields` object |
| Typeform | `form_response.answers[]` with definition mapping |
| GoHighLevel | `type: "FormSubmission"` + `contact` object |
| Facebook / Meta Lead Ads | `object: "page"` + `entry[].changes[].value.field_data[]` |
| HubSpot | Form submission `{submittedAt, data: [{name,value}]}` or contact webhook `[{properties:{}}]` |
| Any other JSON vendor | Generic fallback: scans keys and values for phone, email, and name patterns |

Even for unrecognized vendors, the parser scans field names and values to match phone numbers, email addresses, and names automatically. Any JSON webhook with a phone number in it should produce a valid CTM activity.

---

## Setup

### Step 1 — Create the Lambda in CTM

1. Log in to [CTM](https://app.calltrackingmetrics.com) and go to your account.
2. Navigate to **Account → Integrations → Lambda Functions**.
   - Direct link: `https://app.calltrackingmetrics.com/accounts/YOUR_ACCOUNT_ID/lambdas`
   - Full setup guide: [CTM Lambda Functions](https://calltrackingmetrics.zendesk.com/hc/en-us/articles/6603700875661-CTM-Lambda-Functions)
3. Click **New Lambda Function**.
4. Give it a descriptive name, for example: `Universal Inbound Form Parser`.
5. Paste the entire contents of [`lambda.js`](lambda.js) into the code editor.
6. Click **Save**.

No environment variables or external dependencies are required. The function runs entirely on the built-in Node.js runtime.

---

### Step 2 — Create a Form Reactor

A Form Reactor is the CTM endpoint that receives the webhook POST and routes the form submission to a tracking number.

You need one Form Reactor per form, or one shared reactor if multiple forms should route to the same tracking number.

1. Navigate to **Account → Integrations → Form Reactors**.
   - Full setup guide: [CTM Form Reactors](https://calltrackingmetrics.zendesk.com/hc/en-us/articles/6423010132877-Click-to-Call-Form-FormReactors)
2. Click **New Form Reactor**.
3. Configure:
   - **Name** — something identifiable, for example: `Contact Page Form`
   - **Tracking Number** — the CTM number that should receive calls/texts triggered by this form
   - **Inbound Form Parser** — select the Lambda you created in Step 1

   <img width="1623" height="335" alt="Screenshot 2026-06-20 at 7 08 00 AM" src="https://github.com/user-attachments/assets/7a8f7db9-024b-4b35-bfa3-e8f7da160d76" />

4. Click **Save**.

---

### Step 3 — Copy the Form Reactor POST URL

After saving, CTM generates a unique POST endpoint for this reactor. It looks like this:

```text
https://app.calltrackingmetrics.com/api/v1/accounts/ACCOUNT_ID/form_reactors/REACTOR_ID/submit?key=UNIQUE_KEY

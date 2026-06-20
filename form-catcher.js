function trimValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/^\s+|\s+$/g, "");
}

function normalizeWhitespace(str) {
  return str.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
}

function digitsOnly(value) {
  return trimValue(value).replace(/\D+/g, "");
}

// Returns {phone_number, callback_number, country_code}
// Handles US numbers natively; passes international E164 through rather than dropping them
function extractPhone(raw) {
  var str = trimValue(raw);
  if (!str) return { phone_number: "", callback_number: "", country_code: "1" };

  var digits = digitsOnly(str);

  if (digits.length === 10) {
    return { phone_number: digits, callback_number: "+1" + digits, country_code: "1" };
  }
  if (digits.length === 11 && digits.charAt(0) === "1") {
    var local = digits.slice(1);
    return { phone_number: local, callback_number: "+1" + local, country_code: "1" };
  }
  // International E164 — pass through rather than returning empty
  if (str.charAt(0) === "+" && digits.length >= 7 && digits.length <= 15) {
    return { phone_number: digits, callback_number: str, country_code: "" };
  }
  // Unknown format — pass raw digits and let CTM decide
  if (digits.length >= 7) {
    return { phone_number: digits, callback_number: "", country_code: "1" };
  }
  return { phone_number: "", callback_number: "", country_code: "1" };
}

function looksLikePhone(value) {
  var digits = digitsOnly(String(value || ""));
  return digits.length >= 10 && digits.length <= 15;
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimValue(value));
}

function parseUrlEncoded(str) {
  var result = {};
  var pairs = str.split("&");
  for (var i = 0; i < pairs.length; i++) {
    var idx = pairs[i].indexOf("=");
    if (idx < 0) continue;
    var key = decodeURIComponent(pairs[i].slice(0, idx).replace(/\+/g, " "));
    var val = decodeURIComponent(pairs[i].slice(idx + 1).replace(/\+/g, " "));
    result[key] = val;
  }
  return result;
}

function parseRaw(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  var str = String(raw).replace(/^\s+|\s+$/g, "");
  if (!str) return {};
  if (str.charAt(0) === "{" || str.charAt(0) === "[") {
    try { return JSON.parse(str); } catch (e) {}
  }
  if (str.indexOf("=") !== -1) {
    try { return parseUrlEncoded(str); } catch (e) {}
  }
  return {};
}

function parseBody(event) {
  if (!event) return {};
  var candidate;
  if (event.options && event.options.request_body) {
    candidate = parseRaw(event.options.request_body);
    if (Object.keys(candidate).length) return candidate;
  }
  if (event.request_body) {
    candidate = parseRaw(event.request_body);
    if (Object.keys(candidate).length) return candidate;
  }
  if (event.body) {
    candidate = parseRaw(event.body);
    if (Object.keys(candidate).length) return candidate;
  }
  if (typeof event === "object") return event;
  return parseRaw(event);
}

function extractTypeformValue(answer) {
  if (!answer) return "";
  var t = answer.type;
  if (t === "choice")  return answer.choice  ? trimValue(answer.choice.label) : "";
  if (t === "choices") return answer.choices && Array.isArray(answer.choices.labels)
                               ? answer.choices.labels.join(", ") : "";
  if (t === "boolean") return answer.boolean !== undefined ? String(answer.boolean) : "";
  var v = answer[t];
  return (v !== null && v !== undefined) ? trimValue(String(v)) : "";
}

// For vendors with opaque numeric keys: scan values to infer name/email
function inferHints(flat) {
  var keys = Object.keys(flat).sort(function(a, b) {
    var na = parseInt(a, 10), nb = parseInt(b, 10);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a < b ? -1 : 1;
  });
  var nameHint = "", emailHint = "";
  for (var i = 0; i < keys.length; i++) {
    var v = trimValue(flat[keys[i]]);
    if (!v) continue;
    if (!emailHint && looksLikeEmail(v)) { emailHint = v; continue; }
    if (!nameHint && !looksLikePhone(v) && v.length <= 80 && v.indexOf("\n") === -1)
      nameHint = v;
  }
  if (nameHint  && !flat["__name_hint"])  flat["__name_hint"]  = nameHint;
  if (emailHint && !flat["__email_hint"]) flat["__email_hint"] = emailHint;
  return flat;
}

// Tally field types that map authoritatively to semantic keys
// regardless of what the question label says
var TALLY_TYPE_MAP = {
  "INPUT_PHONE_NUMBER": "phone_number",
  "INPUT_EMAIL":        "email"
};

function normalizeBody(body) {
  var i, keys;

  // Unwrap array-wrapped payloads
  // HubSpot contact webhooks: [{subscriptionType, properties: {firstname, email, phone}}]
  if (Array.isArray(body)) {
    var first = body[0] || {};
    if (first.properties && typeof first.properties === "object") {
      return first.properties;
    }
    body = first;
  }

  // Facebook / Meta Lead Ads
  if (body.object === "page" &&
      Array.isArray(body.entry) &&
      body.entry.length > 0) {
    var entry   = body.entry[0];
    var changes = Array.isArray(entry.changes) && entry.changes.length > 0
                  ? entry.changes[0] : null;
    var fbValue = changes && changes.value ? changes.value : null;
    if (fbValue && Array.isArray(fbValue.field_data)) {
      var fbFlat = {};
      for (i = 0; i < fbValue.field_data.length; i++) {
        var fd  = fbValue.field_data[i];
        var fdk = trimValue(fd.name);
        // Join all values — handles multi-select fields
        var fdv = Array.isArray(fd.values)
                  ? fd.values.map(trimValue).filter(Boolean).join(", ")
                  : trimValue(fd.values);
        if (fdk && fdv) fbFlat[fdk] = fdv;
      }
      // Ad attribution — valuable for CTM paid attribution reporting
      if (fbValue.ad_id)       fbFlat["ad_id"]       = String(fbValue.ad_id);
      if (fbValue.adgroup_id)  fbFlat["adgroup_id"]  = String(fbValue.adgroup_id);
      if (fbValue.campaign_id) fbFlat["campaign_id"] = String(fbValue.campaign_id);
      if (fbValue.leadgen_id)  fbFlat["leadgen_id"]  = String(fbValue.leadgen_id);
      if (fbValue.form_id)     fbFlat["fb_form_id"]  = String(fbValue.form_id);
      return fbFlat;
    }
  }

  // GoHighLevel
  if (body.contact &&
      typeof body.contact === "object" &&
      !Array.isArray(body.contact) &&
      body.type === "FormSubmission") {
    var ghlFlat = {};
    var ckeys = Object.keys(body.contact);
    for (i = 0; i < ckeys.length; i++) ghlFlat[ckeys[i]] = body.contact[ckeys[i]];
    if (body.customField && typeof body.customField === "object") {
      var cfkeys = Object.keys(body.customField);
      for (i = 0; i < cfkeys.length; i++) ghlFlat[cfkeys[i]] = body.customField[cfkeys[i]];
    }
    return ghlFlat;
  }

  // Elementor
  if (body.form_fields &&
      typeof body.form_fields === "object" &&
      !Array.isArray(body.form_fields)) {
    return body.form_fields;
  }

  // Typeform
  if (body.form_response &&
      body.form_response.answers &&
      Array.isArray(body.form_response.answers)) {
    var tfFlat  = {};
    var tfDef   = body.form_response.definition || {};
    var tfFlds  = tfDef.fields || [];
    var titleMap = {};
    for (i = 0; i < tfFlds.length; i++) {
      titleMap[tfFlds[i].id] = trimValue(tfFlds[i].title || tfFlds[i].id);
    }
    var answers = body.form_response.answers;
    for (i = 0; i < answers.length; i++) {
      var ans     = answers[i];
      var fieldId = ans.field && ans.field.id;
      var label   = (fieldId && titleMap[fieldId]) || fieldId || ("answer_" + i);
      var aval    = extractTypeformValue(ans);
      if (aval) tfFlat[label] = aval;
    }
    return tfFlat;
  }

  // HubSpot form submission: {submittedAt, data: [{name, value}], context: {...}}
  if (body.submittedAt !== undefined && Array.isArray(body.data)) {
    var hsFlat = {};
    for (i = 0; i < body.data.length; i++) {
      var hsf = body.data[i];
      var hsk = trimValue(hsf.name);
      var hsv = trimValue(hsf.value);
      if (hsk && hsv) hsFlat[hsk] = hsv;
    }
    return hsFlat;
  }

  // Tally: {data: {fields: [{label, type, value}]}}
  // Checked after HubSpot since both use body.data
  if (body.data &&
      !Array.isArray(body.data) &&
      body.data.fields &&
      Array.isArray(body.data.fields)) {
    var tallyFlat = {};
    for (i = 0; i < body.data.fields.length; i++) {
      var tf   = body.data.fields[i];
      // Use field type for authoritative phone/email mapping
      // so "Best number to reach you" (INPUT_PHONE_NUMBER) is still found
      var tkey = TALLY_TYPE_MAP[tf.type] ||
                 trimValue(tf.label || tf.key || ("field_" + i));
      var tval = Array.isArray(tf.value) ? tf.value.join(", ") : tf.value;
      if (tkey && tval !== null && tval !== undefined) tallyFlat[tkey] = tval;
    }
    return tallyFlat;
  }

  // WPForms: {form_id, form_name, fields: {"1": ..., "2": ...}, meta: {...}}
  if (body.fields &&
      typeof body.fields === "object" &&
      !Array.isArray(body.fields) &&
      body.meta &&
      typeof body.meta === "object") {
    var wpFlat = {};
    var fkeys  = Object.keys(body.fields);
    for (i = 0; i < fkeys.length; i++) {
      var fk      = fkeys[i];
      var flatKey = isNaN(fk) ? fk : ("field_" + fk);
      wpFlat[flatKey] = body.fields[fk];
    }
    return inferHints(wpFlat);
  }

  // Gravity Forms: {form_id, date_created, "1": ..., "2": ...}
  // Numeric field values at top level of the entry object
  keys = Object.keys(body);
  var hasNumericTopKeys = false;
  for (i = 0; i < keys.length; i++) {
    if (/^\d+(\.\d+)?$/.test(keys[i])) { hasNumericTopKeys = true; break; }
  }
  if (body.form_id !== undefined && body.date_created !== undefined && hasNumericTopKeys) {
    var GF_META = {
      id: 1, form_id: 1, ip: 1, source_url: 1, date_created: 1,
      entry_id: 1, created_by: 1, user_agent: 1, payment_status: 1,
      payment_amount: 1, is_starred: 1, is_read: 1, is_fulfilled: 1,
      currency: 1, transaction_id: 1, status: 1
    };
    var gfFlat = {};
    for (i = 0; i < keys.length; i++) {
      var gfk = keys[i];
      if (GF_META[gfk.toLowerCase()]) continue;
      var gfFlatKey = /^\d+(\.\d+)?$/.test(gfk)
                      ? ("field_" + gfk.replace(".", "_")) : gfk;
      gfFlat[gfFlatKey] = body[gfk];
    }
    return inferHints(gfFlat);
  }

  // JotForm: merge rawRequest JSON on top of body
  if (body.rawRequest) {
    try {
      var raw = JSON.parse(body.rawRequest);
      var rawKeys = Object.keys(raw);
      for (var r = 0; r < rawKeys.length; r++) body[rawKeys[r]] = raw[rawKeys[r]];
    } catch (e) {}
  }

  // Zoho: semantic 'phone_number' key alongside generic 'Field_N' keys
  keys = Object.keys(body);
  var hasNamedPhone = body.phone_number !== undefined;
  var hasFieldN     = false;
  for (i = 0; i < keys.length; i++) {
    if (/^Field_\d+$/i.test(keys[i])) { hasFieldN = true; break; }
  }
  if (hasNamedPhone && hasFieldN) {
    var zohoFlat = {};
    var fieldNums = [];
    for (i = 0; i < keys.length; i++) {
      var zm = keys[i].match(/^Field_(\d+)$/i);
      if (zm) fieldNums.push({ num: parseInt(zm[1], 10), key: keys[i] });
      else zohoFlat[keys[i]] = body[keys[i]];
    }
    fieldNums.sort(function(a, b) { return a.num - b.num; });
    for (i = 0; i < fieldNums.length; i++) zohoFlat[fieldNums[i].key] = body[fieldNums[i].key];
    return inferHints(zohoFlat);
  }

  // Generic / unknown vendor — return as-is
  return body;
}

function resolveString(val) {
  if (val === null || val === undefined) return "";
  if (typeof val !== "object") return trimValue(val);
  if (val.area !== undefined && val.phone !== undefined)
    return digitsOnly(val.area) + digitsOnly(val.phone);
  if (val.first !== undefined || val.last !== undefined)
    return trimValue(trimValue(val.first || "") + " " + trimValue(val.last || ""));
  return "";
}

function flattenValue(val) {
  if (val === null || val === undefined) return "";
  if (Array.isArray(val)) return val.map(function(v) { return trimValue(v); }).filter(Boolean).join(", ");
  if (typeof val !== "object") return trimValue(val);
  var parts = [];
  var vkeys = Object.keys(val);
  for (var i = 0; i < vkeys.length; i++) {
    var v = trimValue(val[vkeys[i]]);
    if (v) parts.push(v);
  }
  return parts.join(" ");
}

function keyContains(key, terms) {
  var lower = key.toLowerCase();
  for (var i = 0; i < terms.length; i++) {
    if (lower.indexOf(terms[i]) !== -1) return true;
  }
  return false;
}

var NOISE_KEYS = {
  // JotForm
  rawrequest: 1, jsexecutiontracker: 1, slug: 1, event_id: 1,
  builddate: 1, submitdate: 1, submitsource: 1, timetosubmit: 1,
  validatednewrequiredfieldids: 1, uploadserverurl: 1, eventobserver: 1,
  path: 1, ip: 1, formid: 1, formtitle: 1, formname: 1, submissionid: 1,
  teamid: 1, username: 1, webhookurl: 1, pretty: 1,
  action: 1, appid: 1, custombody: 1, customparams: 1, customtitle: 1,
  documentid: 1, fromtable: 1, issilent: 1, parent: 1,
  product: 1, subject: 1, unread: 1, type: 1,
  // Tally
  eventid: 1, eventtype: 1, createdat: 1, data: 1,
  responseid: 1, respondentid: 1,
  submissionpdfurl: 1, submissionpreviewurl: 1,
  // Typeform
  event_type: 1, form_response: 1,
  // WPForms
  form_id: 1, form_name: 1, fields: 1, meta: 1,
  // GoHighLevel
  locationid: 1, timestamp: 1, form: 1, contact: 1,
  customfield: 1, submissiondata: 1,
  // Facebook
  object: 1, entry: 1,
  // HubSpot
  submittedat: 1, context: 1, legalconsentoptions: 1,
  subscriptiontype: 1, objectid: 1, properties: 1,
  // Internal hints
  __name_hint: 1, __email_hint: 1
};

function isNoisyValue(val) {
  if (typeof val !== "string" || !val) return false;
  if (val.length > 400) return true;
  if (val.indexOf("=>") !== -1 && /[a-z-]+:[a-z0-9]/.test(val)) return true;
  if (/^\d{1,2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2}$/.test(val)) return true;
  if (/^https?:\/\/(api\.tally\.so|[^/]*\.jotform\.com|forms\.zoho\.com)\//.test(val)) return true;
  if (/^https?:\/\/.+\/(thankyou|thank-you|thank_you|confirmation)\b/i.test(val)) return true;
  return false;
}

exports.handler = function(event, context) {
  try {
    var raw  = parseBody(event);
    var body = normalizeBody(raw);

    var callerName  = "";
    var firstName   = "";
    var lastName    = "";
    var email       = "";
    var phoneSource = "";

    var allKeys = Object.keys(body);
    var i, key, resolved;

    // Pass 1: match by key/label patterns
    for (i = 0; i < allKeys.length; i++) {
      key      = allKeys[i];
      resolved = resolveString(body[key]);
      if (!resolved) continue;

      if (!firstName && keyContains(key, ["first name", "first_name", "firstname"]))
        firstName = resolved;

      if (!lastName && keyContains(key, ["last name", "last_name", "lastname"]))
        lastName = resolved;

      if (!callerName &&
          keyContains(key, ["full name", "full_name", "fullname", "caller_name"]) &&
          !keyContains(key, ["first", "last"]))
        callerName = resolved;

      if (!callerName && key.toLowerCase() === "name")
        callerName = resolved;

      if (!callerName && key === "__name_hint")
        callerName = resolved;

      if (!email && keyContains(key, ["email", "e-mail", "e_mail"]))
        email = resolved.toLowerCase();

      if (!email && key === "__email_hint")
        email = resolved.toLowerCase();

      // Added "callback" to catch "callback number" field labels
      if (!phoneSource &&
          keyContains(key, ["phone", "mobile", "cell", "tel", "callback"]) &&
          looksLikePhone(resolved))
        phoneSource = resolved;
    }

    // Combine first + last; normalize whitespace on all name results
    if (!callerName && (firstName || lastName))
      callerName = firstName + " " + lastName;
    callerName = normalizeWhitespace(callerName);

    // Pass 2: phone fallback — scan all values
    if (!phoneSource) {
      for (i = 0; i < allKeys.length; i++) {
        resolved = resolveString(body[allKeys[i]]);
        if (looksLikePhone(resolved)) { phoneSource = resolved; break; }
      }
    }

    // Pass 3: email fallback — scan all values
    if (!email) {
      for (i = 0; i < allKeys.length; i++) {
        resolved = resolveString(body[allKeys[i]]);
        if (looksLikeEmail(resolved)) { email = resolved.toLowerCase(); break; }
      }
    }

    var phoneResult = extractPhone(phoneSource);

    // Custom fields: every non-noise field with custom_ prefix
    var customFields = {};
    for (i = 0; i < allKeys.length; i++) {
      key = allKeys[i];
      if (NOISE_KEYS[key.toLowerCase()]) continue;

      var flat = flattenValue(body[key]);
      if (!flat) continue;
      if (isNoisyValue(flat)) continue;

      var safeKey = "custom_" + key.toLowerCase()
                      .replace(/\s+/g, "_")
                      .replace(/[^a-z0-9_]/g, "");
      if (safeKey === "custom_") continue;

      // Resolve key collisions by appending a counter
      if (customFields[safeKey] !== undefined) {
        var counter = 2;
        while (customFields[safeKey + "_" + counter] !== undefined) counter++;
        safeKey = safeKey + "_" + counter;
      }
      customFields[safeKey] = flat;
    }

    var payload = {
      phone_number:    phoneResult.phone_number,
      callback_number: phoneResult.callback_number,
      country_code:    phoneResult.country_code || "1"
    };

    if (callerName)                       payload.caller_name   = callerName;
    if (email)                            payload.email         = email;
    if (Object.keys(customFields).length) payload.custom_fields = customFields;

    context.done(null, payload);

  } catch (err) {
    // Return a structured error payload so CTM logs it rather than silently losing the lead
    context.done(null, {
      phone_number:    "",
      callback_number: "",
      country_code:    "1",
      custom_fields: {
        custom_parse_error: err && err.message
          ? String(err.message).slice(0, 200)
          : "unknown parse error"
      }
    });
  }
};

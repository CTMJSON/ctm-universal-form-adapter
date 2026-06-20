function trimValue(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/^\s+|\s+$/g, "");
}

function normalizeWhitespace(str) {
  return str.replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
}

// Some vendors (JotForm variable-substitution keys) wrap field names in {braces}.
// Strip them so pattern matching works: {name} → name, {phoneNumber12} → phoneNumber12
function sanitizeKeys(body) {
  var keys = Object.keys(body);
  var dirty = false;
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].charAt(0) === "{" || keys[i].charAt(keys[i].length - 1) === "}") {
      dirty = true; break;
    }
  }
  if (!dirty) return body;
  var clean = {};
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i].replace(/^\{|\}$/g, "");
    clean[k] = body[keys[i]];
  }
  return clean;
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

function looksLikeVisitorSid(value) {
  return /^[a-f0-9]{24}$/i.test(trimValue(value));
}

// Match keys that plausibly carry a CTM visitor/session SID.
// Intentionally excludes generic IDs like submission_id, entry_id, form_id
// to avoid false-positives from Mongo/ObjectId-style values in other fields.
function keyLooksLikeVisitorSid(key) {
  var lower = key.toLowerCase();
  if (lower === "sid" ||
      lower === "visitor_sid" ||
      lower === "ctm_session_id" ||
      lower === "ctm_visitor_sid" ||
      lower === "ctm_sid" ||
      lower === "session_id" ||
      lower === "visitor_id" ||
      lower === "visitorid" ||
      lower === "tracking_sid") return true;
  // Also match compound keys that combine ctm/visitor/session/tracking with sid
  return lower.indexOf("sid") !== -1 && (
    lower.indexOf("ctm")      !== -1 ||
    lower.indexOf("visitor")  !== -1 ||
    lower.indexOf("session")  !== -1 ||
    lower.indexOf("tracking") !== -1
  );
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

  // ActiveCampaign: {type: "subscribe"|"unsubscribe"|..., contact: {email, first_name, last_name, phone, ...}}
  // body.contact is in NOISE_KEYS so all lead data is suppressed by the generic fallback.
  // GHL (above) already handles body.contact when body.type === "FormSubmission";
  // this catches all remaining AC event types.
  if (body.contact &&
      typeof body.contact === "object" &&
      !Array.isArray(body.contact)) {
    return body.contact;
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

  // Klaviyo: {data: {type, id, attributes: {email, first_name, phone_number, custom_properties: {...}}}}
  // Follows JSON:API envelope. body.data is in NOISE_KEYS so the entire payload is otherwise suppressed.
  // Covers both system webhooks (profile/event) and flow webhook actions using the standard template.
  // Inline custom_properties to avoid a "custom_custom_properties" double-prefix in the output.
  if (body.data &&
      !Array.isArray(body.data) &&
      body.data.attributes &&
      typeof body.data.attributes === "object") {
    var kFlat = {};
    var attrs  = body.data.attributes;
    var akeys  = Object.keys(attrs);
    for (i = 0; i < akeys.length; i++) {
      var ak = akeys[i];
      if (ak === "custom_properties" &&
          attrs[ak] &&
          typeof attrs[ak] === "object" &&
          !Array.isArray(attrs[ak])) {
        var cpkeys = Object.keys(attrs[ak]);
        for (var cp = 0; cp < cpkeys.length; cp++) kFlat[cpkeys[cp]] = attrs[ak][cpkeys[cp]];
      } else {
        kFlat[ak] = attrs[ak];
      }
    }
    return kFlat;
  }

  // Cognito Forms: {FormId, FormName, DateSubmitted, Sequence, Fields: {FirstName, LastName, Email, ...}}
  // Capital-F Fields + DateSubmitted distinguishes from all other vendors.
  // Returning Fields directly works because keyContains() lowercases before matching,
  // so PascalCase keys like FirstName, LastName, Email resolve correctly.
  if (body.Fields &&
      typeof body.Fields === "object" &&
      !Array.isArray(body.Fields) &&
      body.DateSubmitted !== undefined) {
    return body.Fields;
  }

  // Fluent Forms: {form_id, form_title, submission_id, inputs: {names: {first_name, last_name}, email, ...}}
  // inputs is a mixed object — some values are nested (names) and some are flat strings
  if (body.inputs &&
      typeof body.inputs === "object" &&
      !Array.isArray(body.inputs)) {
    var ffFlat = {};
    var inputKeys = Object.keys(body.inputs);
    for (i = 0; i < inputKeys.length; i++) {
      var ik = inputKeys[i];
      var iv = body.inputs[ik];
      // Resolve the nested names object into a single full_name key
      if (ik === "names" && iv && typeof iv === "object") {
        var fn = trimValue(iv.first_name || iv.first || "");
        var ln = trimValue(iv.last_name  || iv.last  || "");
        if (fn || ln) ffFlat["full_name"] = normalizeWhitespace(fn + " " + ln);
      } else {
        ffFlat[ik] = iv;
      }
    }
    return ffFlat;
  }

  // Formaloo readable format: {form_slug, submission_id, readable_data: {"Full Name": ..., "Email Address": ..., ...}}
  // readable_data uses human-readable space-separated labels that match our key patterns directly.
  if (body.readable_data &&
      typeof body.readable_data === "object" &&
      !Array.isArray(body.readable_data)) {
    return body.readable_data;
  }

  // Formaloo raw format: {form_slug, submission_id, rendered_data: [{field_id, label, value}]}
  // Convert the label/value array into a flat object so the same key patterns apply.
  if (body.rendered_data && Array.isArray(body.rendered_data)) {
    var fmlFlat = {};
    for (i = 0; i < body.rendered_data.length; i++) {
      var rd    = body.rendered_data[i];
      var rdKey = trimValue(rd.label || rd.field_id || ("field_" + i));
      if (rdKey && rd.value !== null && rd.value !== undefined) fmlFlat[rdKey] = rd.value;
    }
    return fmlFlat;
  }

  // Process Street: {id, type, createdDate, data: {workflow, workflowRun, task, formFields: {...}}}
  // body.data is in NOISE_KEYS so the entire object would otherwise be suppressed.
  // formFields contains the actual submission data with user-defined field keys.
  if (body.data &&
      !Array.isArray(body.data) &&
      body.data.formFields &&
      typeof body.data.formFields === "object" &&
      !Array.isArray(body.data.formFields)) {
    return body.data.formFields;
  }

  // FormAssembly: {submission_id, form_id, timestamp, metadata: {...}, form_data: {first_name, last_name, email, ...}}
  // form_data holds all submission fields with semantic keys. Generic fallback flattens
  // the entire object into one garbled string so name/email/phone are never pattern-matched.
  if (body.form_data &&
      typeof body.form_data === "object" &&
      !Array.isArray(body.form_data)) {
    return body.form_data;
  }

  // Formstack: {Form: {id, name, url}, Submission: {id, timestamp}, fields: {"11223344": {name, label, value}}}
  // fields values are descriptor objects, not raw values; body.Form (capital F) confirms vendor.
  // Use label as the key — it produces human-readable strings that match our key patterns directly.
  if (body.fields &&
      typeof body.fields === "object" &&
      !Array.isArray(body.fields) &&
      body.Form &&
      typeof body.Form === "object") {
    var fsFlat = {};
    var fsKeys = Object.keys(body.fields);
    for (i = 0; i < fsKeys.length; i++) {
      var fsf = body.fields[fsKeys[i]];
      if (!fsf || typeof fsf !== "object") continue;
      var fsKey = trimValue(fsf.label || fsf.name || ("field_" + fsKeys[i]));
      if (fsKey && fsf.value !== null && fsf.value !== undefined) fsFlat[fsKey] = fsf.value;
    }
    return fsFlat;
  }

  // Formidable Forms: {form_id, item_id, item_key, fields: {first_name, last_name, email, ...}}
  // fields object uses semantic string keys — return it directly
  if (body.fields &&
      typeof body.fields === "object" &&
      !Array.isArray(body.fields) &&
      body.item_id !== undefined) {
    return body.fields;
  }

  // Contact Form 7: requires a webhook plugin (CF7 Apps, RT Webhook, etc.).
  // Without this branch, CF7 false-positives into WPForms (both have fields + meta),
  // causing inferHints to pick up "Yes" (from newsletter_consent) as the name hint.
  // CF7 uses "your-{fieldname}" default naming — strip the prefix and convert hyphens
  // to underscores so keyContains() patterns fire: your-name→name, your-email→email,
  // your-first-name→first_name. page_url / submission_date are CF7-middleware specific.
  if (body.fields &&
      typeof body.fields === "object" &&
      !Array.isArray(body.fields) &&
      body.meta &&
      (body.page_url !== undefined || body.submission_date !== undefined)) {
    var cf7Fields = body.fields;
    var cf7Flat   = {};
    var cf7Keys   = Object.keys(cf7Fields);
    for (i = 0; i < cf7Keys.length; i++) {
      var cf7k   = cf7Keys[i];
      var cf7Key = cf7k.replace(/^your-/i, "").replace(/-/g, "_");
      cf7Flat[cf7Key] = cf7Fields[cf7k];
    }
    return cf7Flat;
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

  // Wufoo: URL-encoded or JSON payload with MachineName + opaque FieldN keys (no underscore).
  // Differs from Zoho (Field_N with underscore). When "Include Field and Form Structures"
  // is enabled in Wufoo, companion FieldNLabel keys carry the human field label — use those
  // as semantic keys so keyContains() patterns fire correctly.
  if (body.MachineName !== undefined) {
    var WF_NOISE = { machinename: 1, datecreated: 1, handshakekey: 1, createdby: 1, entryid: 1 };
    var wfValues = {};
    var wfLabels = {};
    var wfFlat   = {};
    var wufooKeys = Object.keys(body);
    var wm;
    for (i = 0; i < wufooKeys.length; i++) {
      var wk = wufooKeys[i];
      if (WF_NOISE[wk.toLowerCase()]) continue;
      wm = wk.match(/^(Field\d+)Label$/i);
      if (wm) { wfLabels[wm[1].toLowerCase()] = trimValue(body[wk]); continue; }
      wm = wk.match(/^Field\d+$/i);
      if (wm) { wfValues[wk.toLowerCase()] = body[wk]; continue; }
      wfFlat[wk] = body[wk];
    }
    var wfIds = Object.keys(wfValues);
    for (i = 0; i < wfIds.length; i++) {
      var wfId = wfIds[i];
      wfFlat[wfLabels[wfId] || wfId] = wfValues[wfId];
    }
    return inferHints(wfFlat);
  }

  // WooCommerce order: billing/shipping objects nested inside order payload.
  // resolveString(body.billing) returns "" (no .value key), so all contact
  // data is unreachable in generic path — flattenValue produces a garbled
  // concatenation. order_key (wc_order_...) is WooCommerce-specific.
  // customer.created webhooks have first_name/email at top level and work
  // without hardening; only order.created needs this branch.
  if (body.billing && typeof body.billing === "object" && body.order_key !== undefined) {
    var wcb = body.billing;
    var wcFlat = {};
    if (wcb.first_name)     wcFlat.first_name     = wcb.first_name;
    if (wcb.last_name)      wcFlat.last_name      = wcb.last_name;
    if (wcb.email)          wcFlat.email          = wcb.email;
    if (wcb.phone)          wcFlat.phone          = wcb.phone;
    if (wcb.company)        wcFlat.company        = wcb.company;
    if (body.customer_note) wcFlat.customer_note  = body.customer_note;
    if (body.status)        wcFlat.order_status   = body.status;
    if (body.total)         wcFlat.order_total    = body.total;
    return wcFlat;
  }

  // GoFormz: {Event, Timestamp, Data: {Fields: {...}, Owner, ...}} envelope.
  // Data (capital D) is suppressed by NOISE_KEYS["data"] in the generic path,
  // swallowing all field content. Fields contains user-defined form field keys —
  // return it directly. Owner (the submitting user's email) is carried as
  // owner_email so keyContains("email") catches it when Fields has no email key.
  if (body.Data && typeof body.Data === "object" && body.Data.Fields && body.Event) {
    var gfzFlat = {};
    var gfzFields = body.Data.Fields;
    var gfzKeys = Object.keys(gfzFields);
    for (i = 0; i < gfzKeys.length; i++) gfzFlat[gfzKeys[i]] = gfzFields[gfzKeys[i]];
    if (body.Data.Owner) gfzFlat.owner_email = body.Data.Owner;
    return gfzFlat;
  }

  // Pipedrive: {event, meta, current, previous} envelope.
  // Deal webhooks nest the contact in current.person_id; person webhooks
  // put name/email/phone directly on current. Email and phone are arrays
  // of {label, value, primary} — pick the primary entry.
  if (body.current && body.meta && body.meta.action) {
    var pdPerson = (body.current.person_id &&
                    typeof body.current.person_id === "object" &&
                    body.current.person_id.name)
                   ? body.current.person_id : body.current;
    var pdFlat = {};
    var pdArr, pdPicked, pdpi;

    if (pdPerson.name) pdFlat.name = pdPerson.name;

    pdArr = pdPerson.email;
    pdPicked = "";
    if (Array.isArray(pdArr)) {
      for (pdpi = 0; pdpi < pdArr.length; pdpi++) {
        if (pdArr[pdpi].primary && pdArr[pdpi].value) { pdPicked = trimValue(pdArr[pdpi].value); break; }
      }
      if (!pdPicked && pdArr[0] && pdArr[0].value) pdPicked = trimValue(pdArr[0].value);
    }
    if (pdPicked) pdFlat.email = pdPicked;

    pdArr = pdPerson.phone;
    pdPicked = "";
    if (Array.isArray(pdArr)) {
      for (pdpi = 0; pdpi < pdArr.length; pdpi++) {
        if (pdArr[pdpi].primary && pdArr[pdpi].value) { pdPicked = trimValue(pdArr[pdpi].value); break; }
      }
      if (!pdPicked && pdArr[0] && pdArr[0].value) pdPicked = trimValue(pdArr[0].value);
    }
    if (pdPicked) pdFlat.phone = pdPicked;

    if (body.current.org_id && body.current.org_id.name)
      pdFlat.company = body.current.org_id.name;
    if (body.current.title) pdFlat.deal_title = body.current.title;

    return pdFlat;
  }

  // ClickFunnels: {event: {type, ...}, data: {first_name, last_name, email, phone, ...}}
  // body.data is suppressed by NOISE_KEYS["data"] in the generic path, swallowing all
  // contact fields. The data object already has semantic keys — return it directly after
  // stripping internal IDs and timestamps. funnel_id is ClickFunnels-specific.
  if (body.event && body.data && body.event.type && body.data.funnel_id !== undefined) {
    var CF_SKIP = { id: 1, contact_id: 1, funnel_id: 1, page_id: 1, ip_address: 1, created_at: 1, updated_at: 1 };
    var cfFlat = {};
    var cfKeys = Object.keys(body.data);
    for (i = 0; i < cfKeys.length; i++) {
      if (!CF_SKIP[cfKeys[i]]) cfFlat[cfKeys[i]] = body.data[cfKeys[i]];
    }
    return cfFlat;
  }

  // Housecall Pro: {event: "job.completed", data: {customer: {...}, invoice: {...}, ...}}
  // body.data is suppressed by NOISE_KEYS["data"]. body.event is a plain string here
  // (not an object like ClickFunnels), so body.event.type is undefined and ClickFunnels
  // branch doesn't fire. Extract customer + invoice + schedule into a flat object;
  // mobile_number triggers keyContains("mobile") automatically.
  if (body.event && typeof body.event === "string" &&
      body.data && typeof body.data === "object" &&
      body.data.customer && typeof body.data.customer === "object") {
    var hcp     = body.data;
    var hcpCust = hcp.customer;
    var hcpFlat = {};
    if (hcpCust.first_name)    hcpFlat.first_name    = hcpCust.first_name;
    if (hcpCust.last_name)     hcpFlat.last_name     = hcpCust.last_name;
    if (hcpCust.email)         hcpFlat.email         = hcpCust.email;
    if (hcpCust.mobile_number) hcpFlat.mobile_number = hcpCust.mobile_number;
    if (hcp.invoice && typeof hcp.invoice === "object") {
      if (hcp.invoice.invoice_number) hcpFlat.invoice_number = hcp.invoice.invoice_number;
      if (hcp.invoice.total     !== undefined) hcpFlat.invoice_total = hcp.invoice.total;
      if (hcp.invoice.balance_due !== undefined) hcpFlat.balance_due = hcp.invoice.balance_due;
    }
    if (hcp.job_number !== undefined) hcpFlat.job_number = hcp.job_number;
    if (hcp.status)   hcpFlat.job_status    = hcp.status;
    if (hcp.schedule && hcp.schedule.arrival_window)
      hcpFlat.arrival_window = hcp.schedule.arrival_window;
    if (Array.isArray(hcp.assigned_employees) && hcp.assigned_employees[0]) {
      var hcpTech = hcp.assigned_employees[0];
      var hcpTechName = [trimValue(hcpTech.first_name || ""), trimValue(hcpTech.last_name || "")].filter(Boolean).join(" ");
      if (hcpTechName) hcpFlat.technician_name = hcpTechName;
    }
    return hcpFlat;
  }

  // ServiceTitan: {Event: {Id, Type, Timestamp}, Tenant: {...}, Data: {Customer, Revenue, ...}}
  // All PascalCase. body.Data suppressed by NOISE_KEYS["data"]. Distinguish from GoFormz
  // (body.Data.Fields) and Housecall Pro (body.event string) by checking that body.Event
  // is an object and body.Data.Customer is present.
  if (body.Event && typeof body.Event === "object" &&
      body.Data && typeof body.Data === "object" &&
      body.Data.Customer && typeof body.Data.Customer === "object") {
    var stData = body.Data;
    var stCust = stData.Customer;
    var stFlat = {};
    if (stCust.Name)  stFlat.name  = stCust.Name;
    if (stCust.Email) stFlat.email = stCust.Email;
    if (stCust.Phone) stFlat.phone = stCust.Phone;
    if (stData.JobNumber) stFlat.job_number = stData.JobNumber;
    if (stData.Status)    stFlat.job_status = stData.Status;
    if (stData.Revenue && stData.Revenue.Total !== undefined)
      stFlat.job_total = stData.Revenue.Total;
    if (stData.Technician && stData.Technician.Name)
      stFlat.technician_name = stData.Technician.Name;
    if (body.Tenant && body.Tenant.Name)
      stFlat.company = body.Tenant.Name;
    return stFlat;
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
    var body = sanitizeKeys(normalizeBody(raw));

    var callerName  = "";
    var firstName   = "";
    var lastName    = "";
    var email       = "";
    var phoneSource = "";
    var visitorSid  = "";

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

      // "callback" catches "callback number" style labels
      if (!phoneSource &&
          keyContains(key, ["phone", "mobile", "cell", "tel", "callback"]) &&
          looksLikePhone(resolved))
        phoneSource = resolved;

      if (!visitorSid && keyLooksLikeVisitorSid(key)) {
        var sidCandidate = resolved || flattenValue(body[key]);
        if (looksLikeVisitorSid(sidCandidate)) visitorSid = trimValue(sidCandidate);
      }
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

      // Skip fields already promoted to top-level visitor_sid
      if (visitorSid && keyLooksLikeVisitorSid(key)) {
        var sidFlat = flattenValue(body[key]);
        if (looksLikeVisitorSid(sidFlat) && trimValue(sidFlat).toLowerCase() === visitorSid.toLowerCase())
          continue;
      }

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
    if (visitorSid)                       payload.visitor_sid   = visitorSid;
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

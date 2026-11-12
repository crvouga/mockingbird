/**
 * The card-field behaviour every emulated Stripe form shares — the Stripe.js Elements, the hosted
 * Checkout page and the customer portal — as one browser script (ES5, no globals but `MBCard`).
 * It does what Stripe's own fields do: brand detection, number grouping per brand, `MM / YY`
 * expiry masking (a leading `2`–`9` becomes `02`–`09`), brand-sized CVC, caret-preserving
 * reformatting, moving to the next field once one is complete, Backspace in an empty field
 * returning to the previous one, and Stripe's validation codes and messages.
 */
export const CARD_CORE = String.raw`var MBCard = (function () {
  "use strict";
  function digits(value) { return String(value == null ? "" : value).replace(/\D/g, ""); }
  function brandOf(value) {
    var n = digits(value);
    if (/^3[47]/.test(n)) return "amex";
    if (/^(5[1-5]|2[2-7])/.test(n)) return "mastercard";
    if (/^(6011|65|64[4-9])/.test(n)) return "discover";
    if (/^3(0[0-5]|[689])/.test(n)) return "diners";
    if (/^35/.test(n)) return "jcb";
    if (/^62/.test(n)) return "unionpay";
    if (/^4/.test(n)) return "visa";
    return "unknown";
  }
  function spec(brand, length) {
    if (brand === "amex") return { lengths: [15], gaps: [4, 6, 5], max: 15, cvc: 4 };
    if (brand === "diners") return { lengths: [14, 16], gaps: length > 14 ? [4, 4, 4, 4] : [4, 6, 4], max: 16, cvc: 3 };
    if (brand === "unionpay" || brand === "unknown") return { lengths: [16, 17, 18, 19], gaps: [4, 4, 4, 4, 3], max: 19, cvc: 3 };
    return { lengths: [16], gaps: [4, 4, 4, 4], max: 16, cvc: 3 };
  }
  function luhn(number) {
    var sum = 0;
    var alternate = false;
    for (var index = number.length - 1; index >= 0; index -= 1) {
      var digit = Number(number[index]);
      if (alternate) { digit *= 2; if (digit > 9) digit -= 9; }
      sum += digit;
      alternate = !alternate;
    }
    return number.length > 0 && sum % 10 === 0;
  }
  function error(code, message) { return { type: "validation_error", code: code, message: message }; }
  /** Stripe's client-side validation of one field; ctx = { brand, country }. */
  function validate(name, value, ctx) {
    ctx = ctx || {};
    if (name === "card") {
      var number = digits(value);
      var card = spec(brandOf(number), number.length);
      var incomplete = error("incomplete_number", "Your card number is incomplete.");
      if (number.length < card.lengths[0]) return incomplete;
      if (card.lengths.indexOf(number.length) === -1) return number.length < card.max ? incomplete : error("invalid_number", "Your card number is invalid.");
      if (!luhn(number)) return error("invalid_number", "Your card number is invalid.");
      return null;
    }
    if (name === "exp") {
      var expiry = digits(value);
      if (expiry.length < 4) return error("incomplete_expiry", "Your card's expiration date is incomplete.");
      var month = Number(expiry.slice(0, 2));
      var year = 2000 + Number(expiry.slice(2, 4));
      if (month < 1 || month > 12) return error("invalid_expiry_month", "Your card's expiration month is invalid.");
      var now = new Date();
      if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) {
        return error("invalid_expiry_year_past", "Your card's expiration year is in the past.");
      }
      return null;
    }
    if (name === "cvc") {
      var cvc = digits(value);
      var size = spec(ctx.brand || "unknown", 0).cvc;
      if (cvc.length < size) return error("incomplete_cvc", "Your card's security code is incomplete.");
      if (cvc.length !== size) return error("invalid_cvc", "Your card's security code is invalid.");
      return null;
    }
    if (name === "zip") {
      var zip = String(value == null ? "" : value).trim();
      if (!zip) return error("incomplete_zip", "Your postal code is incomplete.");
      if (ctx.country === "US" && !/^\d{5}(-?\d{4})?$/.test(zip)) return error("incomplete_zip", "Your postal code is incomplete.");
      return null;
    }
    return null;
  }
  /** The masked value Stripe would show; ctx = { brand, country, deleting }. */
  function format(name, value, ctx) {
    ctx = ctx || {};
    var raw = String(value == null ? "" : value);
    if (name === "card") {
      var number = digits(raw);
      var brand = brandOf(number);
      number = number.slice(0, spec(brand, number.length).max);
      var gaps = spec(brand, number.length).gaps;
      var groups = [];
      var offset = 0;
      for (var index = 0; index < gaps.length && offset < number.length; index += 1) {
        groups.push(number.slice(offset, offset + gaps[index]));
        offset += gaps[index];
      }
      if (offset < number.length) groups.push(number.slice(offset));
      return groups.join(" ");
    }
    if (name === "exp") {
      var expiry = digits(raw);
      if (!ctx.deleting) {
        if (expiry.length === 1 && Number(expiry) > 1) expiry = "0" + expiry;
        else if (expiry.length >= 2 && expiry[0] === "1" && Number(expiry.slice(0, 2)) > 12) expiry = "0" + expiry;
      }
      expiry = expiry.slice(0, 4);
      if (expiry.length > 2 || (expiry.length === 2 && !ctx.deleting)) return expiry.slice(0, 2) + " / " + expiry.slice(2);
      return expiry;
    }
    if (name === "cvc") return digits(raw).slice(0, spec(ctx.brand || "unknown", 0).cvc);
    if (name === "zip") {
      if (ctx.country === "US") return raw.replace(/[^\d-]/g, "").slice(0, 10);
      return raw.replace(/[^0-9A-Za-z -]/g, "").toUpperCase().slice(0, 10);
    }
    return raw;
  }
  function focused(input) {
    return typeof document !== "undefined" && document.activeElement === input && typeof input.setSelectionRange === "function";
  }
  function caretAtEnd(input) {
    return typeof input.selectionStart !== "number" || input.selectionStart >= String(input.value || "").length;
  }
  /** Reformat in place, keeping the caret after the same number of digits it followed. */
  function reformat(input, name, ctx) {
    var before = String(input.value || "");
    var next = format(name, before, ctx);
    if (next === before) return;
    var live = focused(input);
    var caret = live && typeof input.selectionStart === "number" ? input.selectionStart : before.length;
    var atEnd = caret >= before.length;
    var wanted = digits(before.slice(0, caret)).length;
    input.value = next;
    if (!live || atEnd || name === "zip") return;
    var position = 0;
    var seen = 0;
    while (position < next.length && seen < wanted) {
      if (/\d/.test(next[position])) seen += 1;
      position += 1;
    }
    input.setSelectionRange(position, position);
  }
  function deleting(event) {
    return !!(event && typeof event.inputType === "string" && event.inputType.indexOf("delete") === 0);
  }
  function usable(input) {
    return input && !input.disabled && !input.readOnly && !(input.closest && input.closest("[hidden],.mbs-hidden"));
  }
  /**
   * Wire masking and keyboard flow onto ordered fields: [{ name, input }]. options.context()
   * returns { brand, country }; options.advance (default true) moves focus on completion.
   */
  function wire(fields, options) {
    options = options || {};
    var context = options.context || function () {
      var card = fields.filter(function (field) { return field.name === "card"; })[0];
      return { brand: card ? brandOf(card.input.value) : "unknown" };
    };
    fields.forEach(function (field, index) {
      var input = field.input;
      if (!input || !input.addEventListener) return;
      input.addEventListener("input", function (event) {
        var ctx = context();
        ctx.deleting = deleting(event);
        reformat(input, field.name, ctx);
        if (ctx.deleting || options.advance === false || !focused(input) || !caretAtEnd(input)) return;
        if (field.name === "zip" || validate(field.name, input.value, context())) return;
        for (var next = index + 1; next < fields.length; next += 1) {
          if (usable(fields[next].input)) { fields[next].input.focus(); return; }
        }
      });
      input.addEventListener("keydown", function (event) {
        if (!event || event.key !== "Backspace" || input.value !== "" || index === 0) return;
        for (var previous = index - 1; previous >= 0; previous -= 1) {
          var target = fields[previous].input;
          if (!usable(target) || target.tagName === "SELECT") continue;
          event.preventDefault();
          target.focus();
          var end = String(target.value || "").length;
          if (typeof target.setSelectionRange === "function") target.setSelectionRange(end, end);
          return;
        }
      });
    });
  }
  return { digits: digits, brandOf: brandOf, luhn: luhn, spec: spec, validate: validate, format: format, reformat: reformat, wire: wire };
})();`

import { CARD_CORE } from "./card-input.js"
import { CARD_CSS, ICONS, PAYMENT_CSS, THEMES } from "./stripe-js-ui.js"

/**
 * A Stripe.js stand-in served at `GET /v3` in place of https://js.stripe.com/v3. It exposes
 * `Stripe(publishableKey)` with `elements()` → combined or split card inputs (the same
 * `data-testid`s as the hosted page), and `confirmPayment`, `confirmSetup`,
 * `confirmCardPayment`, `confirmCardSetup`, `retrievePaymentIntent`, `retrieveSetupIntent`,
 * `createPaymentMethod` and `handleCardAction`. Confirmation posts to the mock's
 * `/v1/{payment,setup}_intents/{id}/confirm` with the publishable key and client secret, exactly
 * the requests UI suites already wait for; a 3-D Secure test card is authenticated in place.
 *
 * The Elements look and behave like Stripe's: card Elements honour `style`, `classes`,
 * `hideIcon` / `showIcon` and set `StripeElement--*` classes on the mount container; the Payment
 * Element follows the Appearance API (`theme`, `variables`, `rules`, `labels`, `inputs`) and
 * `fonts`, shows field errors after blur, and `elements.submit()` / `confirmPayment` reveal them.
 */
export const stripeJs = (base: string): string => `/* Mockingbird Stripe.js stand-in */
(function () {
  "use strict";
  var BASE = ${JSON.stringify(base)};
  function encode(value, prefix, out) {
    if (value === undefined || value === null) return out;
    if (typeof value === "object" && !Array.isArray(value)) {
      Object.keys(value).forEach(function (key) {
        encode(value[key], prefix ? prefix + "[" + key + "]" : key, out);
      });
    } else if (Array.isArray(value)) {
      value.forEach(function (item, index) { encode(item, prefix + "[" + index + "]", out); });
    } else {
      out.push(encodeURIComponent(prefix) + "=" + encodeURIComponent(String(value)));
    }
    return out;
  }
  function call(method, path, key, params) {
    var body = params ? encode(params, "", []).join("&") : undefined;
    var url = BASE + path + (method === "GET" && body ? "?" + body : "");
    return fetch(url, {
      method: method,
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/x-www-form-urlencoded" },
      body: method === "GET" ? undefined : body,
    }).then(function (response) { return response.json(); });
  }
  function idOf(secret) { return String(secret || "").split("_secret_")[0]; }
  ${CARD_CORE}
  var ICONS = ${JSON.stringify(ICONS)};
  var CARD_CSS = ${JSON.stringify(CARD_CSS)};
  var PAYMENT_CSS = ${JSON.stringify(PAYMENT_CSS)};
  var THEMES = ${JSON.stringify(THEMES)};
  var digits = MBCard.digits;
  var brandOf = MBCard.brandOf;
  function cardError(code, message) {
    return { type: "validation_error", code: code, message: message };
  }
  var FIELDS = {
    card: { testId: "stripe-mock-card", label: "Card number", aria: "Credit or debit card number", autocomplete: "cc-number", inputmode: "numeric", maxlength: 23 },
    exp: { testId: "stripe-mock-exp", label: "Expiration date", aria: "Credit or debit card expiration date", autocomplete: "cc-exp", inputmode: "numeric", maxlength: 7 },
    cvc: { testId: "stripe-mock-cvc", label: "Security code", aria: "Credit or debit card CVC/CVV", autocomplete: "cc-csc", inputmode: "numeric", maxlength: 4 },
    country: { testId: "stripe-mock-country", label: "Country", aria: "Country", autocomplete: "country" },
    zip: { testId: "stripe-mock-zip", label: "ZIP", aria: "ZIP", autocomplete: "postal-code", inputmode: "text", maxlength: 10 },
  };
  var PLACEHOLDERS = {
    card: { card: "Card number", exp: "MM / YY", cvc: "CVC", zip: "ZIP" },
    split: { card: "1234 1234 1234 1234", exp: "MM / YY", cvc: "CVC", zip: "ZIP" },
    payment: { card: "1234 1234 1234 1234", exp: "MM / YY", cvc: "CVC", zip: "12345" },
  };
  var SPLIT = { cardNumber: "card", cardExpiry: "exp", cardCvc: "cvc", postalCode: "zip" };
  var COUNTRIES = [["AU", "Australia"], ["AT", "Austria"], ["BE", "Belgium"], ["BR", "Brazil"], ["CA", "Canada"], ["DK", "Denmark"], ["FI", "Finland"], ["FR", "France"], ["DE", "Germany"], ["HK", "Hong Kong"], ["IE", "Ireland"], ["IT", "Italy"], ["JP", "Japan"], ["MX", "Mexico"], ["NL", "Netherlands"], ["NZ", "New Zealand"], ["NO", "Norway"], ["PL", "Poland"], ["PT", "Portugal"], ["SG", "Singapore"], ["ES", "Spain"], ["SE", "Sweden"], ["CH", "Switzerland"], ["GB", "United Kingdom"], ["US", "United States"]];
  var POSTAL = { US: ["ZIP code", "12345"], CA: ["Postal code", "A1B 2C3"], GB: ["Postal code", "WS11 1DB"] };
  var HOST_CLASSES = { base: "StripeElement", complete: "StripeElement--complete", empty: "StripeElement--empty", focus: "StripeElement--focus", invalid: "StripeElement--invalid", webkitAutofill: "StripeElement--webkit-autofill" };
  var CARD_PSEUDO = [":hover", ":focus", "::placeholder", "::selection", ":-webkit-autofill", ":disabled", ":focus::placeholder", "::-ms-clear"];
  var uid = 0;

  function never(value) { return value === "never"; }
  function collects(options, key) {
    var billing = options.fields && options.fields.billingDetails;
    if (never(billing)) return false;
    var address = billing && billing.address;
    if (never(address)) return false;
    return !(address && never(address[key]));
  }
  function defaultAddress(options) {
    var billing = options.defaultValues && options.defaultValues.billingDetails;
    return (billing && billing.address) || {};
  }
  function countryOf(element) {
    var select = element.node && element.node.querySelector('[name="country"]');
    if (select && select.value) return select.value;
    return defaultAddress(element.options || {}).country || "US";
  }
  function fieldNames(element) {
    var options = element.options || {};
    if (SPLIT[element.type]) return [SPLIT[element.type]];
    if (element.type === "payment") {
      var names = ["card", "exp", "cvc"];
      if (collects(options, "country")) names.push("country");
      if (collects(options, "postalCode") && POSTAL[countryOf(element)]) names.push("zip");
      return names;
    }
    if (element.type !== "card") return [];
    return options.hidePostalCode ? ["card", "exp", "cvc"] : ["card", "exp", "cvc", "zip"];
  }
  function contextOf(element) {
    return { brand: brandOf(element.value("card")), country: element.type === "payment" ? countryOf(element) : undefined };
  }
  function validateField(element, name) {
    if (name === "country") return null;
    return MBCard.validate(name, element.value(name), contextOf(element));
  }
  function stateOf(element) {
    var names = fieldNames(element).filter(function (name) { return name !== "country"; });
    var empty = names.every(function (name) { return String(element.value(name) || "") === ""; });
    var error = null;
    for (var index = 0; index < names.length && !error; index += 1) error = validateField(element, names[index]);
    var event = { complete: !error, empty: empty, elementType: element.type };
    if (error) event.error = error;
    if (element.type === "card" || element.type === "cardNumber") event.brand = brandOf(element.value("card"));
    if (element.type === "payment") { event.collapsed = false; event.value = { type: "card" }; }
    return event;
  }
  function cardValidationOf(element) {
    var card = element.card();
    var values = {
      card: card.number,
      exp: String(card.exp_month || "").padStart(2, "0") + "/" + String(card.exp_year || "").slice(-2),
      cvc: card.cvc,
    };
    var names = ["card", "exp", "cvc"];
    for (var index = 0; index < names.length; index += 1) {
      var error = MBCard.validate(names[index], values[names[index]], { brand: brandOf(card.number) });
      if (error) return error;
    }
    return null;
  }

  function make(tag, className, attributes) {
    var node = document.createElement(tag);
    if (className) node.setAttribute("class", className);
    Object.keys(attributes || {}).forEach(function (key) { node.setAttribute(key, attributes[key]); });
    return node;
  }
  function classes(node, list) { node.setAttribute("class", list.filter(Boolean).join(" ")); }
  function kebab(key) { return key.replace(/[A-Z]/g, function (letter) { return "-" + letter.toLowerCase(); }); }
  function clean(value) { return String(value).replace(/[;{}<>]/g, ""); }
  function declarations(style, skip) {
    return Object.keys(style || {}).filter(function (key) {
      return style[key] !== null && typeof style[key] !== "object" && key.charAt(0) !== ":" && (!skip || skip.indexOf(key) === -1);
    }).map(function (key) {
      return (key === "fontSmoothing" ? "-webkit-font-smoothing" : kebab(key)) + ":" + clean(style[key]);
    }).join(";");
  }
  /** Stripe's card-Element style object ({ base, complete, empty, invalid }) as CSS. */
  function cardStyleCss(style) {
    var css = "";
    var scopes = { base: "%S", complete: "%S.mbs--complete", empty: "%S.mbs--empty", invalid: "%S .mbs-Field--invalid" };
    ["base", "complete", "empty", "invalid"].forEach(function (variant) {
      var rules = style && style[variant];
      if (!rules || typeof rules !== "object") return;
      var scope = scopes[variant];
      var input = scope + " input.mbs-Input";
      var inputBody = declarations(rules, ["iconColor", "padding", "backgroundColor"]);
      if (variant === "base") {
        var rootBody = declarations(rules, ["iconColor"]);
        if (rootBody) css += "%S{" + rootBody + "}";
      }
      if (inputBody) css += input + "{" + inputBody + "}";
      if (rules.iconColor) {
        css += (variant === "invalid" ? "%S .mbs-Icon--invalid" : scope + " .mbs-Icon:not(.mbs-Icon--invalid)") + "{color:" + clean(rules.iconColor) + "}";
      }
      CARD_PSEUDO.forEach(function (pseudo) {
        var nested = rules[pseudo];
        if (!nested || typeof nested !== "object") return;
        var body = declarations(nested, ["iconColor"]);
        if (!body) return;
        var selector = pseudo === ":hover" ? "%S:hover" + scope.slice(2) + " input.mbs-Input" : input + pseudo;
        css += selector + "{" + body + "}";
      });
    });
    return css;
  }
  /** The Appearance API ({ theme, variables, rules }) as CSS over the Payment Element. */
  function appearanceCss(appearance) {
    appearance = appearance || {};
    var theme = THEMES[appearance.theme] || THEMES.stripe;
    var variables = Object.assign({}, theme.variables, appearance.variables || {});
    var css = PAYMENT_CSS + "%S{" + Object.keys(variables).filter(function (key) {
      return /^[A-Za-z0-9]+$/.test(key) && variables[key] !== null && typeof variables[key] !== "object";
    }).map(function (key) { return "--" + key + ":" + clean(variables[key]); }).join(";") + "}" + theme.css;
    var rules = appearance.rules || {};
    Object.keys(rules).forEach(function (selector) {
      var body = declarations(rules[selector]);
      if (!body) return;
      css += selector.split(",").map(function (part) {
        return "%S " + part.trim().replace(/\\.([A-Z][A-Za-z]*)/g, ".mb-$1");
      }).join(",") + "{" + body + "}";
    });
    return css;
  }
  function fontCss(fonts) {
    var imports = "";
    var faces = "";
    (fonts || []).forEach(function (font) {
      if (!font) return;
      if (font.cssSrc) imports += "@import url(" + JSON.stringify(String(font.cssSrc)) + ");";
      else if (font.family && font.src) {
        faces += "@font-face{font-family:" + JSON.stringify(clean(font.family)) + ";src:" + clean(font.src) +
          ";font-weight:" + clean(font.weight || "normal") + ";font-style:" + clean(font.style || "normal") +
          ";font-display:" + clean(font.display || "swap") + (font.unicodeRange ? ";unicode-range:" + clean(font.unicodeRange) : "") + "}";
      }
    });
    return imports + faces;
  }
  function paymentLayout(names, condensed) {
    var has = function (name) { return names.indexOf(name) !== -1; };
    var layout = { card: ["mbs-Span", "mbs-tl", "mbs-tr"], exp: ["mbs-Row2", "mbs-bl"], cvc: ["mbs-Row2", "mbs-Col2", "mbs-br"] };
    if (condensed) {
      layout.country = ["mbs-Span", "mbs-tl", "mbs-tr"].concat(has("zip") ? [] : ["mbs-bl", "mbs-br"]);
      layout.zip = ["mbs-Span", "mbs-bl", "mbs-br"].concat(has("country") ? ["mbs-Row2"] : ["mbs-tl", "mbs-tr"]);
    } else {
      layout.country = has("zip") ? [] : ["mbs-Span"];
      layout.zip = has("country") ? [] : ["mbs-Span"];
    }
    return layout;
  }

  function Element(type, options, group, config) {
    this.type = type;
    this.options = options || {};
    this.group = group;
    this.config = config || {};
    this.node = null;
    this.host = null;
    this.handlers = {};
    this.fields = {};
    this.touched = {};
    this.revealed = false;
    this.focused = null;
  }
  Element.prototype.mount = function (target) {
    var host = typeof target === "string" ? document.querySelector(target) : target;
    if (!host) throw new Error("Mockingbird Stripe.js: mount target not found");
    if (this.node) this.unmount();
    var self = this;
    uid += 1;
    this.uid = uid;
    this.scope = '.mbs[data-mbs="' + uid + '"]';
    var root = make("div", "mbs", { "data-testid": "stripe-mock-element", "data-element-type": this.type, "data-mbs": String(uid) });
    this.node = root;
    this.host = host;
    this.fields = {};
    this.touched = {};
    this.revealed = false;
    this.styleNode = make("style");
    root.appendChild(this.styleNode);
    if (this.type === "payment") this.buildPayment(root);
    else this.buildCard(root);
    var order = (this.type === "payment" ? ["card", "exp", "cvc", "country", "zip"] : ["card", "exp", "cvc", "zip"])
      .filter(function (name) { return self.fields[name]; })
      .map(function (name) { return { name: name, input: self.fields[name].input }; });
    MBCard.wire(order, { context: function () { return contextOf(self); } });
    order.forEach(function (field) {
      var input = field.input;
      input.addEventListener("input", function () {
        self.paint();
        self.emit("change", stateOf(self));
      });
      input.addEventListener("focus", function (event) { self.handleFocus(input, event); });
      input.addEventListener("blur", function (event) { self.handleBlur(input, event); });
    });
    this.restyle();
    host.appendChild(root);
    this.paint();
    setTimeout(function () { self.emit("ready", { elementType: self.type }); }, 0);
    return this;
  };
  Element.prototype.input = function (name, placeholder, className, id) {
    var spec = FIELDS[name];
    var input = make(name === "country" ? "select" : "input", className);
    input.name = name;
    input.setAttribute("data-testid", spec.testId);
    input.setAttribute("autocomplete", spec.autocomplete);
    if (id) input.setAttribute("id", id);
    else input.setAttribute("aria-label", spec.aria);
    if (name === "country") {
      var selected = defaultAddress(this.options).country || "US";
      var list = COUNTRIES.some(function (entry) { return entry[0] === selected; }) ? COUNTRIES : COUNTRIES.concat([[selected, selected]]);
      list.forEach(function (entry) {
        var option = make("option");
        option.value = entry[0];
        option.textContent = entry[1];
        if (entry[0] === selected) option.selected = true;
        input.appendChild(option);
      });
      input.value = selected;
    } else {
      input.setAttribute("type", "text");
      input.setAttribute("inputmode", spec.inputmode);
      input.setAttribute("maxlength", String(spec.maxlength));
      input.setAttribute("spellcheck", "false");
      input.setAttribute("autocorrect", "off");
      input.placeholder = placeholder;
    }
    if (this.options.disabled) input.disabled = true;
    if (this.options.readOnly) input.readOnly = true;
    return input;
  };
  Element.prototype.buildCard = function (root) {
    var self = this;
    var split = !!SPLIT[this.type];
    var showIcon = this.type === "card" ? !this.options.hideIcon : this.type === "cardNumber" && !!this.options.showIcon;
    if (showIcon) {
      this.icon = make("span", "mbs-Icon", { "aria-hidden": "true" });
      root.appendChild(this.icon);
    }
    fieldNames(this).forEach(function (name) {
      var base = "mbs-Field mbs-Field--" + name;
      var wrap = make("span", base);
      var placeholder = split && self.options.placeholder !== undefined ? self.options.placeholder : PLACEHOLDERS[split ? "split" : "card"][name];
      var input = self.input(name, placeholder, "mbs-Input");
      wrap.appendChild(input);
      root.appendChild(wrap);
      self.fields[name] = { wrap: wrap, input: input, base: base };
    });
    var preset = this.options.value && this.options.value.postalCode;
    if (preset && this.fields.zip) this.fields.zip.input.value = String(preset);
  };
  Element.prototype.buildPayment = function (root) {
    var self = this;
    var body = make("div", "mbs-Body");
    this.body = body;
    this.groupErrors = {};
    [["card", "Card information", ["card", "exp", "cvc"]], ["billing", "Country or region", ["country", "zip"]]].forEach(function (section) {
      var names = section[2].filter(function (name) {
        return section[0] === "card" || collects(self.options, name === "zip" ? "postalCode" : "country");
      });
      if (!names.length) return;
      var group = make("div", "mbs-Group");
      var heading = make("div", "mb-Label mbs-GroupLabel", { "aria-hidden": "true" });
      heading.textContent = section[1];
      var grid = make("div", "mbs-Grid");
      names.forEach(function (name) { grid.appendChild(self.paymentField(name, section[0])); });
      var groupError = make("div", "mb-Error mbs-GroupError", { role: "alert" });
      self.groupErrors[section[0]] = groupError;
      group.appendChild(heading);
      group.appendChild(grid);
      group.appendChild(groupError);
      body.appendChild(group);
    });
    root.appendChild(body);
    var preset = defaultAddress(this.options).postal_code;
    if (preset && this.fields.zip) this.fields.zip.input.value = String(preset);
  };
  Element.prototype.paymentField = function (name, section) {
    var id = "mbs-" + this.uid + "-" + name;
    var wrap = make("div", "mbs-Field");
    var label = make("label", "mb-Label", { for: id });
    label.textContent = FIELDS[name].label;
    var control = make("div", "mbs-Control");
    var input = this.input(name, PLACEHOLDERS.payment[name], "mb-Input", id);
    control.appendChild(input);
    var icons = null;
    if (name === "card" || name === "cvc") {
      icons = make("span", "mbs-Icons", { "aria-hidden": "true" });
      control.appendChild(icons);
    }
    var error = make("div", "mb-Error mbs-hidden", { role: "alert" });
    wrap.appendChild(label);
    wrap.appendChild(control);
    wrap.appendChild(error);
    this.fields[name] = { wrap: wrap, input: input, label: label, control: control, icons: icons, error: error, section: section };
    return wrap;
  };
  Element.prototype.restyle = function () {
    if (!this.styleNode) return;
    var css = this.type === "payment" ? appearanceCss(this.config.appearance) : CARD_CSS + cardStyleCss(this.options.style);
    this.styleNode.textContent = (fontCss(this.config.fonts) + css).split("%S").join(this.scope);
  };
  /** The error a field shows now: definite errors at once, incomplete ones after blur or submit. */
  Element.prototype.visibleError = function (name) {
    var error = validateField(this, name);
    if (!error) return null;
    if (this.revealed) return error;
    var value = String(this.value(name) || "");
    if (!value) return null;
    if (error.code.indexOf("incomplete") !== 0) return error;
    return this.touched[name] && this.focused !== name ? error : null;
  };
  Element.prototype.setIcons = function (node, keys) {
    var key = keys.join(",");
    if (!node || node.getAttribute && node.getAttribute("data-icons") === key) return;
    node.setAttribute("data-icons", key);
    node.innerHTML = keys.map(function (name) { return "<span class=\\"mbs-Icon-in\\">" + (ICONS[name] || ICONS.unknown) + "</span>"; }).join("");
  };
  Element.prototype.paint = function () {
    if (!this.node) return;
    var self = this;
    var payment = this.type === "payment";
    var appearance = this.config.appearance || {};
    var floating = appearance.labels === "floating";
    var condensed = appearance.inputs === "condensed";
    var names = fieldNames(this);
    var state = stateOf(this);
    var layout = payment ? paymentLayout(names, condensed) : {};
    var groupErrors = {};
    var invalid = false;
    var brand = brandOf(this.value("card"));
    Object.keys(this.fields).forEach(function (name) {
      var field = self.fields[name];
      var active = names.indexOf(name) !== -1;
      var error = active ? self.visibleError(name) : null;
      var value = String(field.input.value || "");
      if (error) invalid = true;
      field.input.setAttribute("aria-invalid", error ? "true" : "false");
      if (!payment) {
        classes(field.wrap, [field.base, error && "mbs-Field--invalid"]);
        return;
      }
      classes(field.wrap, ["mbs-Field mbs-Field--" + name].concat(layout[name] || [], [!active && "mbs-hidden"]));
      classes(field.input, ["mb-Input", !value && "mb-Input--empty", error && "mb-Input--invalid"]);
      classes(field.label, ["mb-Label", floating && (value || self.focused === name || name === "country" ? "mb-Label--floating" : "mb-Label--resting")]);
      field.error.textContent = error ? error.message : "";
      classes(field.error, ["mb-Error", !error && "mbs-hidden"]);
      if (error && !groupErrors[field.section]) groupErrors[field.section] = error.message;
    });
    if (payment) {
      Object.keys(this.groupErrors).forEach(function (section) {
        var node = self.groupErrors[section];
        node.textContent = groupErrors[section] || "";
        classes(node, ["mb-Error mbs-GroupError", groupErrors[section] && "mbs-shown"]);
      });
      if (this.fields.zip) {
        var postal = POSTAL[countryOf(this)] || POSTAL.US;
        this.fields.zip.label.textContent = postal[0];
        if (this.fields.zip.input.placeholder !== postal[1]) this.fields.zip.input.placeholder = postal[1];
      }
      if (this.fields.card) {
        var keys = brand === "unknown" ? ["visa", "mastercard", "amex", "discover"] : [brand];
        this.setIcons(this.fields.card.icons, keys);
        classes(this.fields.card.control, ["mbs-Control", "mbs-Icons--" + (keys.length > 1 ? 4 : 1)]);
      }
      if (this.fields.cvc) {
        this.setIcons(this.fields.cvc.icons, [brand === "amex" ? "cvcAmex" : "cvc"]);
        classes(this.fields.cvc.control, ["mbs-Control", "mbs-Icons--1"]);
      }
      classes(this.body, ["mbs-Body", floating && "mbs-Floating", condensed && "mbs-Condensed"]);
    }
    if (this.icon) {
      var numberInvalid = this.fields.card && this.visibleError("card");
      var icon = numberInvalid ? "error" : this.focused === "cvc" ? (brand === "amex" ? "cvcAmex" : "cvc") : brand;
      this.setIcons(this.icon, [icon]);
      classes(this.icon, ["mbs-Icon", icon === "error" && "mbs-Icon--invalid"]);
    }
    classes(this.node, ["mbs", payment ? "mbs--payment" : "mbs--card", SPLIT[this.type] && "mbs--split", state.complete && "mbs--complete", state.empty && "mbs--empty", this.focused && "mbs--focus", invalid && "mbs--invalid"]);
    this.paintHost(state, invalid);
  };
  /** Stripe's state classes on the mount container (StripeElement--focus, …), for card Elements. */
  Element.prototype.paintHost = function (state, invalid) {
    var list = this.host && this.host.classList;
    if (!list || this.type === "payment") return;
    var names = Object.assign({}, HOST_CLASSES, this.options.classes || {});
    var on = { base: true, complete: state && state.complete, empty: state && state.empty, focus: !!this.focused, invalid: invalid, webkitAutofill: false };
    Object.keys(names).forEach(function (key) {
      String(names[key] || "").split(/\\s+/).filter(Boolean).forEach(function (name) {
        if (state && on[key]) list.add(name);
        else list.remove(name);
      });
    });
  };
  function inside(element, event) {
    var other = event && event.relatedTarget;
    return !!(other && element.node && element.node.contains && element.node.contains(other));
  }
  Element.prototype.handleFocus = function (input, event) {
    this.focused = input.name;
    this.paint();
    if (!inside(this, event)) this.emit("focus", { elementType: this.type });
  };
  Element.prototype.handleBlur = function (input, event) {
    if (this.focused === input.name) this.focused = null;
    if (String(input.value || "") !== "") this.touched[input.name] = true;
    this.paint();
    if (!inside(this, event)) this.emit("blur", { elementType: this.type });
  };
  /** Show every field's error (as a submit does) and focus the first invalid field. */
  Element.prototype.reveal = function () {
    if (!this.node) return null;
    var self = this;
    this.revealed = true;
    this.paint();
    var state = stateOf(this);
    if (!state.error) return null;
    var first = fieldNames(this).filter(function (name) { return validateField(self, name); })[0];
    var field = first && this.fields[first];
    if (field && field.input.focus) field.input.focus();
    return state.error;
  };
  Element.prototype.value = function (name) {
    var input = this.node && this.node.querySelector('[name="' + name + '"]');
    if (input) return input.value;
    for (var index = 0; index < this.group.length; index += 1) {
      var sibling = this.group[index];
      var siblingInput = sibling !== this && sibling.node && sibling.node.querySelector('[name="' + name + '"]');
      if (siblingInput) return siblingInput.value;
    }
    return "";
  };
  Element.prototype.card = function () {
    var exp = String(this.value("exp") || "").split("/");
    var year = Number(exp[1] || "0");
    return {
      number: digits(this.value("card")),
      exp_month: Number(exp[0] || "0"),
      exp_year: year < 100 ? 2000 + year : year,
      cvc: digits(this.value("cvc")),
    };
  };
  Element.prototype.billing = function () {
    if (this.type !== "payment" || !this.node) return undefined;
    var address = {};
    if (collects(this.options, "country")) address.country = countryOf(this);
    if (fieldNames(this).indexOf("zip") !== -1) address.postal_code = String(this.value("zip") || "").trim();
    return Object.keys(address).length ? { address: address } : undefined;
  };
  Element.prototype.validation = function () { return stateOf(this); };
  Element.prototype.on = function (name, handler) { (this.handlers[name] = this.handlers[name] || []).push(handler); return this; };
  Element.prototype.off = function (name, handler) { this.handlers[name] = (this.handlers[name] || []).filter(function (h) { return h !== handler; }); return this; };
  Element.prototype.once = function (name, handler) { var self = this; var wrapped = function (e) { self.off(name, wrapped); handler(e); }; return this.on(name, wrapped); };
  Element.prototype.emit = function (name, event) { (this.handlers[name] || []).forEach(function (h) { h(event); }); };
  Element.prototype.update = function (options) {
    this.options = Object.assign(this.options, options || {});
    if (!this.node) return;
    var self = this;
    Object.keys(this.fields).forEach(function (name) {
      var input = self.fields[name].input;
      input.disabled = !!self.options.disabled;
      input.readOnly = !!self.options.readOnly;
      if (SPLIT[self.type] && options && options.placeholder !== undefined) input.placeholder = options.placeholder;
    });
    this.restyle();
    this.paint();
    this.emit("change", stateOf(this));
  };
  Element.prototype.focus = function () { var input = this.node && this.node.querySelector("input"); if (input) input.focus(); };
  Element.prototype.blur = function () {
    var self = this;
    var active = typeof document !== "undefined" && document.activeElement;
    var input = Object.keys(this.fields).map(function (name) { return self.fields[name].input; }).filter(function (i) { return i === active; })[0] || (this.node && this.node.querySelector("input"));
    if (input && input.blur) input.blur();
  };
  Element.prototype.clear = function () {
    if (this.node) this.node.querySelectorAll("input").forEach(function (i) { i.value = ""; });
    this.touched = {};
    this.revealed = false;
    this.paint();
    this.emit("change", stateOf(this));
  };
  Element.prototype.collapse = function () {};
  Element.prototype.unmount = function () {
    if (this.node && this.node.parentNode) this.node.parentNode.removeChild(this.node);
    this.paintHost(null, false);
    this.node = null;
    this.focused = null;
  };
  Element.prototype.destroy = Element.prototype.unmount;

  function Stripe(publishableKey, options) {
    if (!(this instanceof Stripe)) return new Stripe(publishableKey, options);
    this.key = publishableKey;
    this.options = options || {};
  }
  Stripe.prototype.elements = function (options) {
    var created = [];
    var clientSecret = options && options.clientSecret;
    var config = { appearance: options && options.appearance, fonts: options && options.fonts };
    return {
      _clientSecret: clientSecret,
      _elements: created,
      create: function (type, opts) { var element = new Element(type, opts, created, config); created.push(element); return element; },
      getElement: function (type) {
        var elementType = type && type.__elementType ? type.__elementType : type;
        return created.filter(function (e) { return e.type === elementType || (e.type === "payment" && type && type.type === "payment"); })[0] || null;
      },
      submit: function () {
        var payment = created.filter(function (e) { return e.type === "payment" && e.node; })[0];
        var error = payment ? payment.reveal() : null;
        return Promise.resolve(error ? { error: error } : {});
      },
      update: function (o) {
        if (o && o.clientSecret) clientSecret = o.clientSecret;
        if (o && o.appearance) config.appearance = o.appearance;
        if (o && o.fonts) config.fonts = o.fonts;
        if (o && (o.appearance || o.fonts)) created.forEach(function (e) { e.restyle(); e.paint(); });
      },
      fetchUpdates: function () { return Promise.resolve({}); },
    };
  };
  function cardData(element) {
    var card = element ? element.card() : { number: "4242424242424242", exp_month: 12, exp_year: 2034, cvc: "123" };
    var data = { type: "card", card: card };
    var billing = element && typeof element.billing === "function" ? element.billing() : undefined;
    if (billing) data.billing_details = billing;
    return data;
  }
  var CARD_TOKENS = {
    "4242424242424242": "tok_visa",
    "4000056655665556": "tok_visa_debit",
    "5555555555554444": "tok_mastercard",
    "378282246310005": "tok_amex",
    "6011111111111117": "tok_discover",
    "4000000000000002": "tok_chargeDeclined",
    "4000000000009995": "tok_chargeDeclinedInsufficientFunds",
    "4000000000000069": "tok_chargeDeclinedExpiredCard",
    "4000000000000341": "tok_chargeCustomerFail",
    "4000002500003155": "tok_threeDSecure2Required",
    "4000002760003184": "tok_threeDSecureRequired",
    "4000000000003220": "tok_authenticationRequired",
    "4000000000000259": "tok_createDispute",
    "4000051230000072": "tok_hsa",
  };
  Stripe.prototype.createToken = function (element) {
    var validation = element && typeof element.validation === "function" ? cardValidationOf(element) : null;
    if (validation) {
      return Promise.resolve({ error: validation });
    }
    if (!element) {
      return Promise.resolve({ error: cardError("incomplete_number", "Your card number is incomplete.") });
    }
    var card = element && typeof element.card === "function" ? element.card() : null;
    var number = card && String(card.number || "").replace(/[\\s-]/g, "");
    var token = number && CARD_TOKENS[number];
    if (!token) {
      return Promise.resolve({ error: { type: "card_error", code: "incorrect_number", message: "Your card number is incorrect." } });
    }
    return Promise.resolve({
      token: {
        id: token,
        object: "token",
        type: "card",
        card: {
          object: "card",
          brand: token === "tok_mastercard" ? "Mastercard" : token === "tok_amex" ? "American Express" : token === "tok_discover" ? "Discover" : "Visa",
          last4: number.slice(-4),
          exp_month: card.exp_month,
          exp_year: card.exp_year,
        },
      },
    });
  };
  Stripe.prototype._finish = function (kind, clientSecret, result, options) {
    var self = this;
    if (result && result.error) return Promise.resolve({ error: result.error });
    var authenticate = result && result.status === "requires_action"
      ? call("POST", "/c/3ds/" + result.id + "/authenticate", this.key, { client_secret: clientSecret })
      : Promise.resolve(result);
    return authenticate.then(function (intent) {
      if (intent && intent.error) return { error: intent.error };
      var out = {};
      out[kind === "payment_intent" ? "paymentIntent" : "setupIntent"] = intent;
      var failed = intent.status !== "succeeded" && intent.status !== "processing" && intent.status !== "requires_capture";
      if (failed && intent.last_payment_error) return { error: intent.last_payment_error };
      if (failed && intent.last_setup_error) return { error: intent.last_setup_error };
      var returnUrl = options && options.returnUrl;
      if (returnUrl && options.redirect !== "if_required") {
        var sep = returnUrl.indexOf("?") === -1 ? "?" : "&";
        window.location.assign(returnUrl + sep + kind + "=" + encodeURIComponent(intent.id) + "&" + kind + "_client_secret=" + encodeURIComponent(clientSecret) + "&redirect_status=" + (failed ? "failed" : "succeeded"));
      }
      return out;
    });
  };
  Stripe.prototype._confirm = function (kind, clientSecret, paymentMethod, extra, options) {
    var self = this;
    var params = Object.assign({ client_secret: clientSecret }, extra || {});
    if (typeof paymentMethod === "string") params.payment_method = paymentMethod;
    else if (paymentMethod) params.payment_method_data = paymentMethod;
    var path = kind === "payment_intent" ? "/v1/payment_intents/" : "/v1/setup_intents/";
    return call("POST", path + idOf(clientSecret) + "/confirm", this.key, params).then(function (result) {
      return self._finish(kind, clientSecret, result, options);
    });
  };
  function paymentElementOf(elements) {
    if (!elements || !elements._elements) return null;
    return elements._elements.filter(function (e) { return e.type === "payment" || e.type === "card"; })[0] || null;
  }
  Stripe.prototype.confirmPayment = function (args) {
    var mounted = paymentElementOf(args.elements);
    var invalid = mounted && mounted.type === "payment" ? mounted.reveal() : null;
    if (invalid) return Promise.resolve({ error: invalid });
    var secret = args.clientSecret || (args.elements && args.elements._clientSecret);
    var confirmParams = args.confirmParams || {};
    var method = confirmParams.payment_method || cardData(paymentElementOf(args.elements));
    var extra = confirmParams.return_url ? { return_url: confirmParams.return_url } : {};
    return this._confirm("payment_intent", secret, method, extra, { returnUrl: confirmParams.return_url, redirect: args.redirect });
  };
  Stripe.prototype.confirmSetup = function (args) {
    var mounted = paymentElementOf(args.elements);
    var invalid = mounted && mounted.type === "payment" ? mounted.reveal() : null;
    if (invalid) return Promise.resolve({ error: invalid });
    var secret = args.clientSecret || (args.elements && args.elements._clientSecret);
    var confirmParams = args.confirmParams || {};
    var method = confirmParams.payment_method || cardData(paymentElementOf(args.elements));
    var extra = confirmParams.return_url ? { return_url: confirmParams.return_url } : {};
    return this._confirm("setup_intent", secret, method, extra, { returnUrl: confirmParams.return_url, redirect: args.redirect });
  };
  function cardMethod(data) {
    var method = data && data.payment_method;
    if (typeof method === "string") return method;
    if (method && method.card && typeof method.card.card === "function") return cardData(method.card);
    return cardData(null);
  }
  Stripe.prototype.confirmCardPayment = function (clientSecret, data) {
    return this._confirm("payment_intent", clientSecret, cardMethod(data), data && data.return_url ? { return_url: data.return_url } : {}, { redirect: "if_required" });
  };
  Stripe.prototype.confirmCardSetup = function (clientSecret, data) {
    return this._confirm("setup_intent", clientSecret, cardMethod(data), {}, { redirect: "if_required" });
  };
  Stripe.prototype.handleCardAction = function (clientSecret) {
    var self = this;
    return call("GET", "/v1/payment_intents/" + idOf(clientSecret), this.key, { client_secret: clientSecret }).then(function (intent) {
      return self._finish("payment_intent", clientSecret, intent, { redirect: "if_required" });
    });
  };
  Stripe.prototype.retrievePaymentIntent = function (clientSecret) {
    return call("GET", "/v1/payment_intents/" + idOf(clientSecret), this.key, { client_secret: clientSecret }).then(function (intent) {
      return intent.error ? { error: intent.error } : { paymentIntent: intent };
    });
  };
  Stripe.prototype.retrieveSetupIntent = function (clientSecret) {
    return call("GET", "/v1/setup_intents/" + idOf(clientSecret), this.key, { client_secret: clientSecret }).then(function (intent) {
      return intent.error ? { error: intent.error } : { setupIntent: intent };
    });
  };
  Stripe.prototype.createPaymentMethod = function (args) {
    var element = args && (args.card || paymentElementOf(args.elements));
    var card = element && typeof element.card === "function" ? element.card() : { number: "4242424242424242" };
    return call("POST", "/v1/payment_methods", this.key, { type: "card", card: card, billing_details: (args && args.billing_details) || undefined }).then(function (method) {
      return method.error ? { error: method.error } : { paymentMethod: method };
    });
  };
  Stripe.prototype.paymentRequest = function () {
    return { canMakePayment: function () { return Promise.resolve(null); }, on: function () {}, show: function () {}, update: function () {} };
  };
  Stripe.version = 3;
  window.Stripe = Stripe;
})();
`

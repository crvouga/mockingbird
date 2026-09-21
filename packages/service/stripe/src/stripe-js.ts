/**
 * A Stripe.js stand-in served at `GET /v3` in place of https://js.stripe.com/v3. It exposes
 * `Stripe(publishableKey)` with `elements()` → `create("payment" | "card")` rendering plain inputs
 * (the same `data-testid`s as the hosted page), and `confirmPayment`, `confirmSetup`,
 * `confirmCardPayment`, `confirmCardSetup`, `retrievePaymentIntent`, `retrieveSetupIntent`,
 * `createPaymentMethod` and `handleCardAction`. Confirmation posts to the mock's
 * `/v1/{payment,setup}_intents/{id}/confirm` with the publishable key and client secret, exactly
 * the requests UI suites already wait for; a 3-D Secure test card is authenticated in place.
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
  var FIELDS = [
    ["card", "Card number", "stripe-mock-card", "4242 4242 4242 4242"],
    ["exp", "Expiry (MM/YY)", "stripe-mock-exp", "12/34"],
    ["cvc", "CVC", "stripe-mock-cvc", "123"],
    ["zip", "ZIP", "stripe-mock-zip", "94107"],
  ];
  function Element(type, options) {
    this.type = type;
    this.options = options || {};
    this.node = null;
    this.handlers = {};
  }
  Element.prototype.mount = function (target) {
    var host = typeof target === "string" ? document.querySelector(target) : target;
    if (!host) throw new Error("Mockingbird Stripe.js: mount target not found");
    var root = document.createElement("div");
    root.setAttribute("data-testid", "stripe-mock-element");
    root.setAttribute("data-element-type", this.type);
    FIELDS.forEach(function (field) {
      var label = document.createElement("label");
      label.textContent = field[1];
      var input = document.createElement("input");
      input.name = field[0];
      input.setAttribute("data-testid", field[2]);
      input.placeholder = field[3];
      label.appendChild(input);
      root.appendChild(label);
    });
    host.appendChild(root);
    this.node = root;
    var self = this;
    root.addEventListener("input", function () { self.emit("change", { complete: true, empty: false, elementType: self.type }); });
    setTimeout(function () { self.emit("ready", { elementType: self.type }); }, 0);
    return this;
  };
  Element.prototype.value = function (name) {
    var input = this.node && this.node.querySelector('[name="' + name + '"]');
    return input ? input.value : "";
  };
  Element.prototype.card = function () {
    var exp = (this.value("exp") || "12/34").split("/");
    var year = Number(exp[1] || "34");
    return {
      number: (this.value("card") || "4242424242424242").replace(/\\s+/g, ""),
      exp_month: Number(exp[0] || "12"),
      exp_year: year < 100 ? 2000 + year : year,
      cvc: this.value("cvc") || "123",
    };
  };
  Element.prototype.on = function (name, handler) { (this.handlers[name] = this.handlers[name] || []).push(handler); return this; };
  Element.prototype.off = function (name, handler) { this.handlers[name] = (this.handlers[name] || []).filter(function (h) { return h !== handler; }); return this; };
  Element.prototype.once = function (name, handler) { var self = this; var wrapped = function (e) { self.off(name, wrapped); handler(e); }; return this.on(name, wrapped); };
  Element.prototype.emit = function (name, event) { (this.handlers[name] || []).forEach(function (h) { h(event); }); };
  Element.prototype.update = function (options) { this.options = Object.assign(this.options, options || {}); };
  Element.prototype.focus = function () { var input = this.node && this.node.querySelector("input"); if (input) input.focus(); };
  Element.prototype.blur = function () {};
  Element.prototype.clear = function () { if (this.node) this.node.querySelectorAll("input").forEach(function (i) { i.value = ""; }); };
  Element.prototype.collapse = function () {};
  Element.prototype.unmount = function () { if (this.node && this.node.parentNode) this.node.parentNode.removeChild(this.node); this.node = null; };
  Element.prototype.destroy = Element.prototype.unmount;

  function Stripe(publishableKey, options) {
    if (!(this instanceof Stripe)) return new Stripe(publishableKey, options);
    this.key = publishableKey;
    this.options = options || {};
  }
  Stripe.prototype.elements = function (options) {
    var created = [];
    var clientSecret = options && options.clientSecret;
    return {
      _clientSecret: clientSecret,
      _elements: created,
      create: function (type, opts) { var element = new Element(type, opts); created.push(element); return element; },
      getElement: function (type) { return created.filter(function (e) { return e.type === type || (e.type === "payment" && type && type.type === "payment"); })[0] || null; },
      submit: function () { return Promise.resolve({}); },
      update: function (o) { if (o && o.clientSecret) clientSecret = o.clientSecret; },
      fetchUpdates: function () { return Promise.resolve({}); },
    };
  };
  function cardData(element) {
    var card = element ? element.card() : { number: "4242424242424242", exp_month: 12, exp_year: 2034, cvc: "123" };
    return { type: "card", card: card };
  }
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
    var secret = args.clientSecret || (args.elements && args.elements._clientSecret);
    var confirmParams = args.confirmParams || {};
    var method = confirmParams.payment_method || cardData(paymentElementOf(args.elements));
    var extra = confirmParams.return_url ? { return_url: confirmParams.return_url } : {};
    return this._confirm("payment_intent", secret, method, extra, { returnUrl: confirmParams.return_url, redirect: args.redirect });
  };
  Stripe.prototype.confirmSetup = function (args) {
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

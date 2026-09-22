import {
  jsonResponse,
  type OperationContext,
  type OperationHandler,
} from "@crvouga/mockingbird-service"
import {
  invalidRequest,
  parameterInvalidEmpty,
  parameterMissing,
  resourceMissing,
  StripeError,
} from "./errors.js"
import { applyExpand, type ExpandResolvers } from "./expand.js"
import {
  mergeMetadata,
  optionalBoolean,
  optionalString,
  strip,
  strippedString,
  validateStatementDescriptor,
} from "./fields.js"
import { changedFields, type RequestScope, requestScope, type Services } from "./internal.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import { renderDeletedProduct, renderPrice, renderProduct } from "./render.js"
import { searchRecords } from "./search.js"
import { type PackageDimensions, type ProductRecord, seconds } from "./state.js"
import { validateUrl } from "./url.js"

const PRODUCT_URL_LENGTH_LIMIT = 800
const CREATE_NON_UNSETTABLE: Record<string, true> = {
  description: true,
  unit_label: true,
  url: true,
}

/** Order in which Stripe validates product parameters (observed, not alphabetical). */
const PRODUCT_PARAM_ORDER = [
  "name",
  "description",
  "metadata",
  "active",
  "images",
  "shippable",
  "url",
  "package_dimensions",
  "statement_descriptor",
  "unit_label",
  "marketing_features",
]

const productValidators = (
  mode: "create" | "update",
  current: ProductRecord | undefined,
): Record<string, (params: Params) => void> => {
  const notEmpty = (key: string) => (params: Params) => {
    if (params[key] === "" && (mode === "create" ? CREATE_NON_UNSETTABLE[key] === true : false))
      throw parameterInvalidEmpty(key)
  }
  return {
    name: (params) => {
      if (mode === "create" && params.name === undefined) throw parameterMissing("name")
      if (typeof params.name === "string" && strip(params.name) === "")
        throw parameterInvalidEmpty("name")
    },
    description: notEmpty("description"),
    metadata: (params) => {
      if (mode === "create" && params.metadata === "") throw parameterInvalidEmpty("metadata")
    },
    unit_label: notEmpty("unit_label"),
    images: (params) => {
      if (!Array.isArray(params.images)) return
      params.images.forEach((image, index) => {
        if (typeof image === "string") validateUrl(image, `images[${index}]`)
      })
    },
    url: notEmpty("url"),
    statement_descriptor: (params) => {
      const descriptor = params.statement_descriptor
      if (typeof descriptor !== "string" || descriptor === "") return
      if (descriptor !== current?.statement_descriptor) validateStatementDescriptor(descriptor)
    },
  }
}

/** Stripe validates the URL itself only after every other parameter has been accepted. */
const validateProductUrl = (params: Params) => {
  if (typeof params.url === "string" && params.url !== "")
    validateUrl(params.url, "url", PRODUCT_URL_LENGTH_LIMIT)
}

const apply = (current: ProductRecord, params: Params, now: number): ProductRecord => {
  const next: ProductRecord = { ...current, updated: now }
  next.active = optionalBoolean(params, "active", current.active) ?? true
  next.description = optionalString(params, "description", current.description)
  if (params.images !== undefined)
    next.images = params.images === "" ? [] : (params.images as string[])
  if (params.marketing_features !== undefined)
    next.marketing_features =
      params.marketing_features === ""
        ? []
        : // Stripe trims each feature name.
          (params.marketing_features as Array<{ name: string }>).map((feature) => ({
            ...feature,
            name: feature.name.trim(),
          }))
  next.metadata = mergeMetadata(current.metadata, params.metadata)
  if (typeof params.name === "string") next.name = strip(params.name)
  if (params.package_dimensions !== undefined) {
    next.package_dimensions =
      params.package_dimensions === "" ? null : (params.package_dimensions as PackageDimensions)
  }
  next.shippable = optionalBoolean(params, "shippable", current.shippable)
  next.statement_descriptor = strippedString(
    params,
    "statement_descriptor",
    current.statement_descriptor,
  )
  next.unit_label = optionalString(params, "unit_label", current.unit_label)
  if (params.url !== undefined) next.url = params.url as string
  if (params.default_price !== undefined)
    next.default_price = params.default_price === "" ? null : (params.default_price as string)
  return next
}

export const requireProduct = (
  scope: RequestScope,
  id: string,
  param: string,
  status = 404,
): ProductRecord => {
  const product = scope.account.products.get(id)
  if (!product) throw resourceMissing("product", id, param, status)
  return product
}

const expanders = (scope: RequestScope): ExpandResolvers => ({
  default_price: (id) => {
    const price = scope.account.prices.get(id)
    return price ? renderPrice(price) : undefined
  },
})

export const productHandlers = (services: Services): Record<string, OperationHandler> => {
  const render = (scope: RequestScope, product: ProductRecord, params: Params) =>
    applyExpand(renderProduct(product), params.expand, expanders(scope))

  return {
    PostProducts: async (context: OperationContext) => {
      const scope = requestScope(services, context)
      const params = bodyParams(context, {
        order: PRODUCT_PARAM_ORDER,
        validate: productValidators("create", undefined),
        after: validateProductUrl,
      })
      const now = seconds(scope.now)
      const requested = typeof params.id === "string" && params.id !== "" ? params.id : null
      if (requested !== null && scope.account.products.get(requested))
        throw new StripeError({
          status: 400,
          code: "resource_already_exists",
          message: "Product already exists.",
          param: "id",
        })
      const id = requested ?? scope.ids.next("prod_")
      const base: ProductRecord = {
        id,
        active: true,
        created: now,
        description: null,
        images: [],
        marketing_features: [],
        metadata: {},
        name: "",
        package_dimensions: null,
        shippable: null,
        statement_descriptor: null,
        unit_label: null,
        updated: now,
        url: null,
      }
      const product = apply(base, params, now)
      scope.account.products.insert(id, product)
      scope.emit("product.created", render(scope, product, params))
      return jsonResponse(200, render(scope, product, params))
    },

    GetProducts: async (context: OperationContext) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const ids = params.ids as string[] | undefined
      if (ids !== undefined) {
        for (const cursor of ["starting_after", "ending_before"]) {
          if (typeof params[cursor] === "string" && params[cursor] !== "")
            throw invalidRequest(
              `You may only specify one of these parameters: ids, ${cursor}.`,
              "ids",
            )
        }
      }
      const url = params.url
      const page = await paginate<ProductRecord>(scope.account.products, params, {
        url: "/v1/products",
        kind: "product",
        where: (product) =>
          matchesCreated(product.created, params.created) &&
          (params.active === undefined || product.active === params.active) &&
          (params.shippable === undefined || product.shippable === params.shippable) &&
          (url === undefined || url === "" || product.url === url) &&
          (ids === undefined || ids.includes(product.id)),
        render: renderProduct,
      })
      return jsonResponse(200, applyExpand(page, params.expand, expanders(scope)))
    },

    GetProductsSearch: async (context: OperationContext) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      const records = scope.account.products.list({ order: "newest" }).map((entry) => entry.value)
      const page = searchRecords(records, params, {
        url: "/v1/products/search",
        render: renderProduct,
        lag: scope.effect("search_lag"),
        now: scope.now,
      })
      return jsonResponse(200, applyExpand(page, params.expand, expanders(scope)))
    },

    GetProductsId: async (context: OperationContext) => {
      const scope = requestScope(services, context)
      const params = queryParams(context)
      return jsonResponse(
        200,
        render(scope, requireProduct(scope, context.params.id ?? "", "id"), params),
      )
    },

    PostProductsId: async (context: OperationContext) => {
      const scope = requestScope(services, context)
      const id = context.params.id ?? ""
      const current = requireProduct(scope, id, "id")
      const params = bodyParams(context, {
        order: PRODUCT_PARAM_ORDER,
        validate: productValidators("update", current),
        after: validateProductUrl,
      })
      const defaultPrice = params.default_price
      if (typeof defaultPrice === "string" && defaultPrice !== "") {
        const price = scope.account.prices.get(defaultPrice)
        if (!price) throw resourceMissing("price", defaultPrice, "default_price")
        if (price.product !== id)
          throw invalidRequest(
            `The price \`${defaultPrice}\` does not belong to this product.`,
            "default_price",
          )
      }
      const product = apply(current, params, seconds(scope.now))
      scope.account.products.update(id, product)
      scope.emit(
        "product.updated",
        renderProduct(product),
        changedFields(renderProduct(current), renderProduct(product)),
      )
      return jsonResponse(200, render(scope, product, params))
    },

    DeleteProductsId: async (context: OperationContext) => {
      const scope = requestScope(services, context)
      const id = context.params.id ?? ""
      requireProduct(scope, id, "id")
      const prices = scope.account.prices.list({ where: (price) => price.product === id })
      if (prices.length > 0)
        throw invalidRequest(
          "This product cannot be deleted because it has one or more user-created prices.",
        )
      scope.account.products.delete(id)
      scope.emit("product.deleted", renderDeletedProduct(id))
      return jsonResponse(200, renderDeletedProduct(id))
    },
  }
}

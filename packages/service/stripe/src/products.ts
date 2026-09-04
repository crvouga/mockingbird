import { jsonResponse, type OperationContext } from "@crvouga/mockingbird-service"
import {
  invalidRequest,
  parameterInvalidEmpty,
  parameterMissing,
  resourceMissing,
} from "./errors.js"
import {
  mergeMetadata,
  optionalBoolean,
  optionalString,
  strip,
  strippedString,
  validateStatementDescriptor,
} from "./fields.js"
import { matchesCreated, paginate } from "./list.js"
import { bodyParams, type Params, queryParams } from "./params.js"
import { type PackageDimensions, type ProductRecord, type StripeState, seconds } from "./state.js"
import { validateUrl } from "./url.js"

export const renderProduct = (product: ProductRecord) => ({
  id: product.id,
  object: "product",
  active: product.active,
  attributes: [],
  created: product.created,
  default_price: null,
  description: product.description,
  images: product.images,
  livemode: false,
  marketing_features: product.marketing_features,
  metadata: product.metadata,
  name: product.name,
  package_dimensions: product.package_dimensions,
  shippable: product.shippable,
  statement_descriptor: product.statement_descriptor,
  tax_code: null,
  tax_details: null,
  type: "service",
  unit_label: product.unit_label,
  updated: product.updated,
  url: product.url,
})

const PRODUCT_URL_LENGTH_LIMIT = 800
const CREATE_NON_UNSETTABLE = new Set(["description", "unit_label", "url"])

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
    if (params[key] === "" && (mode === "create" ? CREATE_NON_UNSETTABLE.has(key) : false))
      throw parameterInvalidEmpty(key)
  }
  return {
    name: (params) => {
      if (mode === "create" && params.name === undefined) throw parameterMissing("name")
      if (typeof params.name === "string" && strip(params.name) === "")
        throw parameterInvalidEmpty("name")
    },
    description: notEmpty("description"),
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
      params.marketing_features === "" ? [] : (params.marketing_features as Array<{ name: string }>)
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
  return next
}

export const requireProduct = async (
  state: StripeState,
  id: string,
  param: string,
  status: number,
) => {
  const product = await state.products.get(id)
  if (!product) throw resourceMissing("product", id, param, status)
  return product
}

export const productHandlers = (state: StripeState) => ({
  PostProducts: async (context: OperationContext) => {
    const params = bodyParams(context, {
      order: PRODUCT_PARAM_ORDER,
      validate: productValidators("create", undefined),
      after: validateProductUrl,
    })
    const now = seconds(context.now)
    const id = await state.ids.next("prod_")
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
    await state.products.insert(id, product)
    return jsonResponse(200, renderProduct(product))
  },

  GetProducts: async (context: OperationContext) => {
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
    const page = await paginate<ProductRecord>(state.products, params, {
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
    return jsonResponse(200, page)
  },

  GetProductsId: async (context: OperationContext) => {
    queryParams(context)
    const product = await requireProduct(state, context.params.id ?? "", "id", 404)
    return jsonResponse(200, renderProduct(product))
  },

  PostProductsId: async (context: OperationContext) => {
    const id = context.params.id ?? ""
    const current = await requireProduct(state, id, "id", 404)
    const params = bodyParams(context, {
      order: PRODUCT_PARAM_ORDER,
      validate: productValidators("update", current),
      after: validateProductUrl,
    })
    const product = apply(current, params, seconds(context.now))
    await state.products.update(id, product)
    return jsonResponse(200, renderProduct(product))
  },

  DeleteProductsId: async (context: OperationContext) => {
    const id = context.params.id ?? ""
    await requireProduct(state, id, "id", 404)
    const prices = await state.prices.list({ where: (price) => price.product === id })
    if (prices.length > 0)
      throw invalidRequest(
        "This product cannot be deleted because it has one or more user-created prices.",
      )
    await state.products.delete(id)
    return jsonResponse(200, { id, object: "product", deleted: true })
  },
})

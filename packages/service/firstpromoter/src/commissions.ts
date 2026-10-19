import { jsonRes } from "@crvouga/mockingbird-service"
import type {
  CommissionBatch,
  CommissionRecord,
  CommissionTask,
  FirstPromoterState,
} from "./state.js"

/** Stored commissions and deterministic batch work share the promoter/referral collections. */
export class Commissions {
  constructor(
    private readonly state: FirstPromoterState,
    private readonly now: () => number,
  ) {}

  enrolment(id: number) {
    for (const promoter of this.state.all()) {
      const entry = promoter.campaigns.find((c) => c.id === id)
      if (entry) return { promoter, entry, campaign: this.state.campaign(entry.campaign_id) }
    }
    return undefined
  }

  seed(input: Omit<CommissionRecord, "id" | "created_at">): CommissionRecord | undefined {
    const owner = this.enrolment(input.promoter_campaign_id)
    if (!owner) return undefined
    if (input.referral_id !== null) {
      const referral = this.state.referrals.get(String(input.referral_id))
      if (
        !referral ||
        referral.promoter_id !== owner.promoter.id ||
        referral.campaign_id !== owner.entry.campaign_id
      )
        return undefined
    }
    const row = {
      ...input,
      id: 92_000_000 + this.state.next("commission"),
      created_at: new Date(this.now()).toISOString(),
    }
    this.state.commissions.insert(String(row.id), row)
    return row
  }

  render(row: CommissionRecord) {
    const owner = this.enrolment(row.promoter_campaign_id)
    const referral =
      row.referral_id === null ? undefined : this.state.referrals.get(String(row.referral_id))
    const reward = owner?.campaign?.promoterRewards[0]
    return {
      id: row.id,
      status: row.status,
      metadata: {},
      is_self_referral: false,
      commission_type: row.commission_type,
      created_by_user_email: null,
      created_by_user_at: null,
      sale_amount: row.sale_amount,
      original_sale_amount: row.sale_amount,
      original_sale_currency: row.original_sale_currency,
      event_id: row.event_id,
      plan_id: row.plan_id,
      tier: 1,
      internal_note: row.internal_note ?? null,
      external_note: row.external_note ?? null,
      unit: row.unit,
      fraud_check: "no_suspicion",
      amount: row.amount,
      is_paid: row.is_paid,
      is_split: false,
      created_at: row.created_at,
      status_updated_at: null,
      promoter_campaign: owner
        ? {
            id: owner.entry.id,
            campaign_id: owner.entry.campaign_id,
            promoter_id: owner.promoter.id,
            created_at: owner.entry.created_at,
            promoter: {
              id: owner.promoter.id,
              email: owner.promoter.email,
              name:
                [owner.promoter.first_name, owner.promoter.last_name].filter(Boolean).join(" ") ||
                owner.promoter.email,
            },
            campaign: owner.campaign
              ? { id: owner.campaign.id, name: owner.campaign.name, color: owner.campaign.color }
              : null,
          }
        : null,
      referral: referral ? { id: referral.id, email: referral.email, uid: referral.uid } : null,
      reward: { id: reward?.reward_id ?? 0, name: reward?.name ?? "Custom commission" },
      split_details: null,
    }
  }

  /** `PUT /v2/company/commissions/{id}`: only the two notes are writable. */
  updateNotes(
    id: number,
    notes: { internal_note?: string; external_note?: string },
  ): CommissionRecord | undefined {
    const row = this.state.commissions.get(String(id))
    if (!row) return undefined
    const next: CommissionRecord = {
      ...row,
      ...(notes.internal_note !== undefined ? { internal_note: notes.internal_note } : {}),
      ...(notes.external_note !== undefined ? { external_note: notes.external_note } : {}),
    }
    this.state.commissions.update(String(id), next)
    return next
  }

  list(query: URLSearchParams): Response {
    const selected = query.getAll("ids[]")
    const search = query.get("q")?.toLowerCase() ?? ""
    const inRange = (row: CommissionRecord, field: "amount" | "sale_amount" | "created_at") => {
      const value = field === "created_at" ? row.created_at.slice(0, 10) : row[field]
      const from = query.get(`filters[${field}][from]`)
      const to = query.get(`filters[${field}][to]`)
      return (
        (!from || value >= (field === "created_at" ? from : Number(from))) &&
        (!to || value <= (field === "created_at" ? to : Number(to)))
      )
    }
    const rows = this.state.commissions
      .list({
        order: "newest",
        where: (row) => {
          const owner = this.enrolment(row.promoter_campaign_id)
          const referral =
            row.referral_id === null ? undefined : this.state.referrals.get(String(row.referral_id))
          const status = query.get("filters[status]")
          const fulfilled = query.get("filters[fulfilled]")
          const paid = query.get("filters[paid]")
          const promoter = query.get("filters[promoter_id]")
          const campaign = query.get("filters[campaign_id]")
          return (
            (!selected.length || selected.includes(String(row.id))) &&
            (!status || row.status === status) &&
            (!fulfilled || (row.unit !== "cash" && row.fulfilled === (fulfilled === "yes"))) &&
            (!paid || (row.unit === "cash" && row.is_paid === (paid === "yes"))) &&
            (!promoter || String(owner?.promoter.id) === promoter) &&
            (!campaign || String(owner?.entry.campaign_id) === campaign) &&
            (!search ||
              [
                String(row.id),
                row.event_id ?? "",
                owner?.promoter.email ?? "",
                referral?.email ?? "",
                referral?.uid ?? "",
              ].some((value) => value.toLowerCase().includes(search))) &&
            inRange(row, "amount") &&
            inRange(row, "sale_amount") &&
            inRange(row, "created_at")
          )
        },
      })
      .map((row) => row.value)
    const page = Math.max(1, Math.floor(Number(query.get("page")) || 1))
    const size = Math.min(100, Math.max(1, Math.floor(Number(query.get("per_page")) || 20)))
    return jsonRes(
      200,
      rows.slice((page - 1) * size, page * size).map((row) => this.render(row)),
    )
  }

  submit(
    ids: number[],
    action: CommissionTask["action"],
    partialFailure: boolean,
  ): CommissionBatch {
    const unique = [...new Set(ids)]
    const asynchronous = ids.length > 5
    const now = this.now()
    const timestamp = new Date(now).toISOString()
    const batch: CommissionBatch = {
      id: 300_000 + this.state.next("batch"),
      status: asynchronous ? "pending" : "completed",
      total: unique.length,
      selected_total: unique.length,
      processed_count: 0,
      failed_count: 0,
      action_label: `commission/${action}`,
      created_at: timestamp,
      updated_at: timestamp,
      meta: {},
      progress: 0,
      processing_errors: [],
    }
    this.state.batches.insert(String(batch.id), batch)
    const task: CommissionTask = {
      batch_id: batch.id,
      ids: unique,
      action,
      started_at: now,
      due_at: now + 1000,
      fail_id: partialFailure ? (unique[0] ?? null) : null,
    }
    if (asynchronous) this.state.commissionTasks.insert(String(batch.id), task)
    else this.finish(task)
    return this.state.batches.get(String(batch.id)) as CommissionBatch
  }

  settle(): void {
    for (const { id, value: task } of this.state.commissionTasks.list()) {
      if (this.now() >= task.due_at) {
        this.finish(task)
        this.state.commissionTasks.delete(id)
      } else if (this.now() > task.started_at) {
        const batch = this.state.batches.get(String(task.batch_id))
        if (batch)
          this.state.batches.update(String(task.batch_id), {
            ...batch,
            status: "in_progress",
            updated_at: new Date(this.now()).toISOString(),
          })
      }
    }
  }

  private finish(task: CommissionTask): void {
    const batch = this.state.batches.get(String(task.batch_id))
    if (!batch) return
    const errors: string[] = []
    let processed = 0
    for (const id of task.ids) {
      const row = this.state.commissions.get(String(id))
      if (id === task.fail_id) errors.push(`Commission ${id}: injected batch failure`)
      else if (!row) errors.push(`Commission ${id} not found`)
      else if (task.action === "mark_fulfilled" && row.unit === "cash")
        errors.push(`Commission ${id} is monetary`)
      else {
        if (task.action === "destroy") this.state.commissions.delete(String(id))
        else this.state.commissions.update(String(id), { ...row, fulfilled: true })
        processed++
      }
    }
    this.state.batches.update(String(batch.id), {
      ...batch,
      status: "completed",
      processed_count: processed,
      failed_count: errors.length,
      progress: 100,
      processing_errors: errors,
      updated_at: new Date(this.now()).toISOString(),
    })
  }
}

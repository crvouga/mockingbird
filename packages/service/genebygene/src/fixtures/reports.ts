/** Synthetic comprehensive report in the format returned by the results API. */
export const NORMAL_REPORT: Record<string, unknown> = {
  id: 1,
  name: "Example Person",
  dob: "2000-01-01",
  sex: "female",
  barcode: "WB000001",
  lab_identifier: "WB000001",
  report_date: "2025-01-01T00:00:00.000Z",
  gene_summary: {
    diet_types: [],
    macronutrients: [{ name: "Example nutrient", option_bullets: '["Example observation"]' }],
    graph_genotypes: [],
    supplements: [],
  },
  health_sections: [
    {
      menuId: 1,
      title: "Example panel",
      items: [
        {
          subMenuId: 1,
          name: "Example trait",
          score: 50,
          apoe_name: null,
          selectedOption: {
            title: "Example option",
            description: "Synthetic report item",
            bullets: '["Example observation"]',
          },
        },
      ],
    },
  ],
  epigenetic_scores: [{ epigenetic_submenu_id: 1, score: 50, apoe_name: null }],
}

export const PGX_REPORT: Record<string, unknown> = {
  id: 19679,
  name: "Jane Doe",
  dob: "2000-01-01",
  sex: "female",
  barcode: "WB000000",
  lab_identifier: "WB000000",
  report_date: "2026-03-16T16:20:43.293Z",
  gene_summary: {
    diet_types: [],
    macronutrients: [],
    supplements: [],
    graph_genotypes: [
      {
        gene: "CYP2D6",
        rs_id: "rs3892097",
        genotype: "CT",
        status: "Intermediate metabolizer",
      },
      {
        gene: "CYP2C19",
        rs_id: "rs4244285",
        genotype: "GG",
        status: "Normal metabolizer",
      },
      {
        gene: "SLCO1B1",
        rs_id: "rs4149056",
        genotype: "TC",
        status: "Decreased function",
      },
      {
        gene: "VKORC1",
        rs_id: "rs9923231",
        genotype: "CT",
        status: "Intermediate sensitivity",
      },
    ],
  },
  health_sections: [
    {
      menuId: 101,
      title: "Medication Metabolism",
      items: [
        {
          subMenuId: 1001,
          name: "CYP2D6",
          score: 40,
          apoe_name: null,
          selectedOption: {
            title: "Intermediate metabolizer",
            description: "CYP2D6 metabolizes roughly a quarter of commonly prescribed drugs.",
            bullets: [
              "Reduced activation of codeine and tramadol",
              "Discuss dosing of tricyclic antidepressants with your clinician",
            ],
          },
        },
        {
          subMenuId: 1002,
          name: "CYP2C19",
          score: 50,
          apoe_name: null,
          selectedOption: {
            title: "Normal metabolizer",
            description: "CYP2C19 activates clopidogrel and clears several proton-pump inhibitors.",
            bullets: ["Standard dosing is expected to be effective"],
          },
        },
      ],
    },
    {
      menuId: 102,
      title: "Statin Response",
      items: [
        {
          subMenuId: 1003,
          name: "SLCO1B1",
          score: 30,
          apoe_name: null,
          selectedOption: {
            title: "Decreased function",
            description: "SLCO1B1 transports statins into the liver.",
            bullets: ["Higher simvastatin exposure; consider an alternative statin or lower dose"],
          },
        },
      ],
    },
    {
      menuId: 103,
      title: "Anticoagulant Sensitivity",
      items: [
        {
          subMenuId: 1004,
          name: "VKORC1",
          score: 45,
          apoe_name: null,
          selectedOption: {
            title: "Intermediate sensitivity",
            description: "VKORC1 is the target of warfarin.",
            bullets: ["A lower warfarin starting dose may be appropriate"],
          },
        },
      ],
    },
  ],
  epigenetic_scores: [],
}

export const ANCESTRY_REPORT: Record<string, unknown> = {
  id: 19680,
  name: "Jane Doe",
  dob: "2000-01-01",
  sex: "female",
  barcode: "WB000000",
  lab_identifier: "WB000000",
  report_date: "2026-03-16T16:20:43.293Z",
  gene_summary: {
    diet_types: [],
    macronutrients: [],
    supplements: [],
    graph_genotypes: [
      {
        name: "Maternal haplogroup",
        result: "H1a",
      },
    ],
  },
  health_sections: [
    {
      menuId: 201,
      title: "Ancestry Composition",
      items: [
        {
          subMenuId: 2001,
          name: "Northern European",
          score: 62,
          apoe_name: null,
          selectedOption: {
            title: "Northern European 62%",
            description: "Autosomal ancestry estimate.",
            bullets: ["British Isles 41%", "Scandinavia 21%"],
          },
        },
        {
          subMenuId: 2002,
          name: "Southern European",
          score: 28,
          apoe_name: null,
          selectedOption: {
            title: "Southern European 28%",
            description: "Autosomal ancestry estimate.",
            bullets: ["Iberia 19%", "Italy 9%"],
          },
        },
        {
          subMenuId: 2003,
          name: "West Asian",
          score: 10,
          apoe_name: null,
          selectedOption: {
            title: "West Asian 10%",
            description: "Autosomal ancestry estimate.",
            bullets: ["Anatolia 10%"],
          },
        },
      ],
    },
    {
      menuId: 202,
      title: "Haplogroups",
      items: [
        {
          subMenuId: 2004,
          name: "mtDNA",
          score: null,
          apoe_name: null,
          selectedOption: {
            title: "H1a",
            description: "Maternal line haplogroup.",
            bullets: ["Most common European maternal lineage"],
          },
        },
      ],
    },
  ],
  epigenetic_scores: [],
  ancestry: {
    composition: [
      {
        population: "Northern European",
        percent: 62,
      },
      {
        population: "Southern European",
        percent: 28,
      },
      {
        population: "West Asian",
        percent: 10,
      },
    ],
    maternalHaplogroup: "H1a",
  },
}

/** Synthetic CSV rows exercise genotype parsing. */
export const RAW_DATA_CSV =
  "RSID,CHROMOSOME,POSITION,RESULT\nrs100000001,1,1001,CT\nrs100000002,2,1002,AA\n"

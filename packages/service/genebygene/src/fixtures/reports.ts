/**
 * Result payloads the mock publishes when a kit reaches `Completed`, by fixture name:
 *
 * - `normal`: the consumer's own comprehensive-report fixture
 *   (`GXG/results/comprehensive-report/fixtures/comprehensive-report.json`, synthetic "Jane Doe",
 *   vendor sample WBF2F422), trimmed to the first item of each section so the bundle stays small.
 *   It parses with `gxgComprehensiveReportSchema`.
 * - `pgx`: the same report schema with pharmacogenomic sections (synthetic).
 * - `ancestry`: the same report schema with ancestry sections (synthetic).
 *
 * Every fixture also ships the raw-data CSV (`GXG/simulate/fixtures/wellness-results.csv`) and a
 * one-page PDF.
 */

export const NORMAL_REPORT: Record<string, unknown> = {
  id: 19678,
  name: "Jane Doe",
  dob: "2000-01-01",
  sex: "male",
  barcode: "WBF2F422",
  lab_identifier: "WBF2F422",
  report_date: "2026-03-16T16:20:43.293Z",
  gene_summary: {
    diet_types: [],
    diet_type_upgrade_message:
      "Your Diet Type Compatibility section requires an upgrade to our Agena MassARRAY to genotype genes not found on your current DNA data file. Please contact customer service to find out how you can upgrade.",
    macronutrients: [
      {
        name: "Prebiotic Fiber",
        option_bullets:
          '["Your genotypes are associated with an average requirement for prebiotic fiber"]',
      },
      {
        name: "Micronutrients",
        option_bullets: "B12 (Cobalamin), B3 (Niacin), Copper, Magnesium",
      },
    ],
    graph_genotypes: [],
    supplements: [],
  },
  health_sections: [
    {
      menuId: 1,
      title: "APOE Status",
      items: [
        {
          subMenuId: 93,
          name: null,
          score: 50,
          apoe_name: "3/3",
          selectedOption: {
            title: "ApoE-e3",
            description:
              "Apolipoprotein E (ApoE) is a lipid-binding protein that transports triglycerides and cholesterol in multiple tissues, including the brain. The e4 allele is common in hunter-gatherer communities, while the e3 and e2 alleles are most common in agricultural communities.",
            bullets:
              '["ApoE 3\\/3 is the most common ApoE genotype found in agricultural communities and has numerous benefits","Extended cognitive fitness and enhanced expression of anti-aging sirtuins","Improved HDL and LDL profile","Improved ability to repair synapses and neural protection","Higher viral protection","Higher response to plant bioactive compounds","In the brain, e2 and e3 accumulate in neurons 2 to 4-fold higher than e4"]',
          },
        },
      ],
    },
    {
      menuId: 4,
      title: "Protein Requirements",
      items: [
        {
          subMenuId: 33,
          name: "Protein",
          score: 2,
          apoe_name: "3/3",
          selectedOption: {
            title: "AVERAGE",
            description:
              "Traditional protein intake ranges based on latitude from less than 18% of total calories to approximately 35% in the far northern climates. Recommended protein intake varies based on weight and exercise intensity.",
            bullets:
              '["Genetically, your requirements fall on the average side of the spectrum, approximately 18-20% of total caloric intake"]',
          },
        },
      ],
    },
    {
      menuId: 21,
      title: "Carbohydrate Requirements",
      items: [
        {
          subMenuId: 209,
          name: "Carbohydrates",
          score: 99,
          apoe_name: "3/3",
          selectedOption: {
            title: "NORMAL",
            description:
              "Your carbohydrate intake range is based on the latitude of your ancestors and whether a hunter-gatherer diet or modern agricultural diet made a larger imprint on your genes.",
            bullets:
              '["Your genotype combination is associated with improved carbohydrate metabolism, allowing 40% to 55% of total calories from carbohydrates if desired","For a 2,000 calorie diet, this comes to 200 to 275 grams of carbohydrates per day"]',
          },
        },
      ],
    },
    {
      menuId: 5,
      title: "Fat Requirements",
      items: [
        {
          subMenuId: 39,
          name: "Omega-3's",
          score: 99,
          apoe_name: "3/3",
          selectedOption: {
            title: "HIGH",
            description:
              "The NIH has set the recommended intake of omega-3's from 1.1 to 1.6 grams per day from a combination of ALA, EPA and DHA. Omega-3 fatty acids are essential for brain, eye, and cardiovascular health.",
            bullets:
              '["Your genotype combinations are associated with a higher requirement of EPA and DHA","ApoE e2 and e3 carriers can benefit from non-phospholipid fish oil intake, however, e4 carriers should use phospholipid-based EPA and DHA as found in fish and fish roe","For ApoE e4 carriers, fish oil supplements do not appear as effective as phospholipid-based EPA and DHA as found in fish and fish roe","E4 carriers may have impaired transport of free DHA and require phospholipids for successful transport"]',
          },
        },
      ],
    },
    {
      menuId: 28,
      title: "Celiac Disease",
      items: [
        {
          subMenuId: 243,
          name: "Celiac Disease",
          score: 2,
          apoe_name: "3/3",
          selectedOption: {
            title: "LOW PRIORITY",
            description:
              "Celiac disease is an immune reaction to eating gluten, a protein found in wheat, barley and rye. Published research shows that approximately 30 percent of the general population have variants in the celiac disease risk genes HLA-DQA1 through HLA-DQB, yet only 3% of these individuals develop celiac disease.",
            bullets:
              '["Your genotype combination is associated with a low genetic risk for celiac disease","On a global level, the rates of celiac disease are not related either to the amount of wheat consumed by each country or to the prevalence of the HLA DR3-DQ2 and DR4-DQ8 genotypes worldwide","First-degree relatives of people with celiac disease including parents, siblings and children have a 1 in 10 risk compared to 1 in 100 in the general population, which may be increased by existing autoimmune disorders"]',
          },
        },
      ],
    },
    {
      menuId: 7,
      title: "Micronutrient Requirements",
      items: [
        {
          subMenuId: 47,
          name: "B1 (Thiamine)",
          score: 2,
          apoe_name: "3/3",
          selectedOption: {
            title: "",
            description:
              "The recommended daily allowance (RDA) for thiamine is 1.2mg. Thiamine requirements are analyzed based on ethanol metabolism, however, chronic intake of alcohol depletes thiamine.",
            bullets: '["Your genotype is associated with an average need for B1"]',
          },
        },
      ],
    },
    {
      menuId: 23,
      title: "Fiber Requirements",
      items: [
        {
          subMenuId: 43,
          name: "Prebiotic Fiber",
          score: 2,
          apoe_name: "3/3",
          selectedOption: {
            title: "AVERAGE",
            description:
              "The recommended amount of fiber is up to 25 grams per day for women and up to 38 grams per day for men.",
            bullets:
              '["Your genotypes are associated with an average requirement for prebiotic fiber"]',
          },
        },
      ],
    },
    {
      menuId: 11,
      title: "Phytonutrient Requirements",
      items: [
        {
          subMenuId: 68,
          name: "Phytoestrogens",
          score: 50,
          apoe_name: "3/3",
          selectedOption: {
            title: "INCREASED",
            description:
              "Phytoestrogens are plant derived compounds found in a wide variety of foods. There are pros and cons to phytoestrogen intake that appears to have a genetic, age, and gut health connection for determining optimal intake.",
            bullets:
              '["Your genotype combinations are associated with a higher than average need for phytoestrogens for healthy hormones","Phytoestrogens are highest in soy, flax, beans, rye, wheat, hummus, peanuts, tahini sauce, and cruciferous vegetables"]',
          },
        },
      ],
    },
    {
      menuId: 9,
      title: "Lactose Tolerance",
      items: [
        {
          subMenuId: 66,
          name: "Lactose Tolerance",
          score: 2,
          apoe_name: "3/3",
          selectedOption: {
            title: "TOLERANT",
            description:
              "Lactose is the major carbohydrate in milk. The arrival of farming in Europe around 8,500 years ago necessitated adaptation to new environments, pathogens, diets, and social organizations. One of the best examples of genetic dietary changes to this is the lactase enzyme in northern Europeans that only dates to the last 4,000 years.",
            bullets:
              '["Your LCT genotype is associated with lactose tolerance","The ability to digest lactose is much more common in people of European ancestry","Approximately 32 percent of the world\\u2019s population is lactose tolerant","Since this gene only looks at lactose, sensitivities to dairy can still exist"]',
          },
        },
      ],
    },
    {
      menuId: 8,
      title: "Caffeine Metabolism",
      items: [
        {
          subMenuId: 65,
          name: "Caffeine Metabolism",
          score: 50,
          apoe_name: "3/3",
          selectedOption: {
            title: "INTERMEDIATE",
            description:
              "Variants in the CYP1A2  gene determine the rate at which you metabolize caffeine.",
            bullets:
              '["You are an intermediate metabolizer of caffeine, meaning your body breaks down caffeine at an intermediate rate, giving you an average sensitivity to the effects of increased consumption"]',
          },
        },
      ],
    },
    {
      menuId: 15,
      title: "Toxin Sensitivity",
      items: [
        {
          subMenuId: 98,
          name: "Mycotoxins",
          score: 99,
          apoe_name: "3/3",
          selectedOption: {
            title: "HIGH PRIORITY",
            description:
              "Mycotoxins are toxic compounds that are naturally produced by certain types of fungi. Research suggests that mycotoxins can decrease the formation of glutathione due to decreased gene expression of the enzymes needed to form glutathione.",
            bullets:
              '["Your genotype is associated with lower glutathione levels which may cause glutathione depletion to occur at a faster rate and decrease mycotoxin detoxification","The highest exposure to mycotoxins can be in foods grown or stored in damp conditions","This may include grains, nuts, corn, coffee, wine, beer, grape juice, sorghum, rice, dried beans, apples, pulses, cacao products, and spices","Boosting glutathione can be accomplished with selenium, glycine, cysteine, alpha lipoic acid, vitamin C, and cruciferous vegetables"]',
          },
        },
      ],
    },
    {
      menuId: 26,
      title: "Pesticides, Herbicides and Heavy Metal Sensitivity",
      items: [
        {
          subMenuId: 97,
          name: "Glyphosate",
          score: 50,
          apoe_name: "3/3",
          selectedOption: {
            title: "MEDIUM PRIORITY",
            description: "Glyphosate is an herbicide that has been found to be highly toxic.",
            bullets:
              '["Your genotype is associated with potentially more cellular damage from exposure to the herbicide glyphosate","The highest glyphosate levels have been found in non-organic wheat and non-organic pulses like beans, lentils, and peas","A meta-analysis of human epidemiological studies suggests a link between exposures to glyphosate and an increased risk for non-Hodgkin\\u2019s lymphoma","An association between glyphosate and thyroid disease comes from plots over time of the usage of glyphosate in the U.S. on corn and soy time-aligned with plots of the incidence rate of thyroid cancer in the U.S.","Manganese deficiency and toxicity can occur simultaneously from glyphosate exposure due to a disruption in liver enzymes, causing transportation of manganese through the vagus nerve to the brainstem where excess manganese can lead to Parkinson\\u2019s disease","The gut bacterium Lactobacillus is negatively impacted by glyphosate and the depletion in associated with celiac disease","Humic acid from Shilajit has been shown in vivo to reduce glyphosate concentration, inhibit the destructive effect of glyphosate on beneficial bacteria, and protect and repair against tight junction injury of the digestive system"]',
          },
        },
      ],
    },
    {
      menuId: 3,
      title: "Mental Health and Cognitive Performance",
      items: [
        {
          subMenuId: 27,
          name: "Brain Repair and Maintenance",
          score: 50,
          apoe_name: "3/3",
          selectedOption: {
            title: "MEDIUM PRIORITY",
            description:
              "Multiple genes are responsible for daily neural repair and maintenance, and a combination of genotypes are associated with decreased neural repair.",
            bullets:
              '["Your genotype combination is associated with slightly reduced neural repair, which can affect healing from brain injuries and amplify damage from poor sleep patterns","Limit or avoid activities with a high risk of concussions","Get eight hours of sleep per night for optimal repair","Be proactive with neural repair by focusing on safe endurance exercise, DHA, B-vitamins, Lion\'s Mane mushroom, zinc, vitamin C, and vitamin E"]',
          },
        },
      ],
    },
    {
      menuId: 25,
      title: "Warrior or Strategist",
      items: [
        {
          subMenuId: 24,
          name: "Pressure Response",
          score: 99,
          apoe_name: "3/3",
          selectedOption: {
            title: "STRATEGIST",
            description:
              'Your COMT genotype is associated with the "Strategist" that has the highest dopamine levels and may thrive more in low-pressure environments combined with complex problem-solving.',
            bullets:
              '["If your levels of dopamine get too high and you find yourself irritable, impulsive, and stressed, add strength training 3-5 times a week and increase your magnesium and vitamin C intake for balance.","Low catecholamine (coffee, green tea, red wine, chocolate) intake recommended due to their effect on dopamine","For men and premenopausal women, avoid IPA beers due to a higher estrogenic effect that can slow COMT down further"]',
          },
        },
      ],
    },
    {
      menuId: 12,
      title: "Sleep Support",
      items: [
        {
          subMenuId: 80,
          name: "Sleep Duration Requirement",
          score: null,
          apoe_name: null,
          selectedOption: {
            title: "AVERAGE SLEEP",
            description:
              "The ApoE gene is associated with average or extended sleep requirements for healthy brain repair each night.",
            bullets:
              '["Your ApoE genotype is associated with average sleep duration (7-8 hours) requirements for neural repair"]',
          },
        },
      ],
    },
    {
      menuId: 24,
      title: "Stress Management",
      items: [
        {
          subMenuId: 195,
          name: "Stress Perception",
          score: 2,
          apoe_name: "3/3",
          selectedOption: {
            title: "AVERAGE PRIORITY",
            description:
              "Your perception of stress is unique to your genotypes and life experience. Variants in 5-HT2A are associated with perceived stress, low vagal tone, anxiety, depression, OCD, and IBS, especially in females.",
            bullets: '["Your genotypes are associated with a lower perception of stress."]',
          },
        },
      ],
    },
    {
      menuId: 17,
      title: "Bacteria, Yeast, Parasites and Viruses",
      items: [
        {
          subMenuId: 207,
          name: "H. Pylori",
          score: 2,
          apoe_name: "3/3",
          selectedOption: {
            title: "AVERAGE PROTECTION",
            description:
              "The inactive “non-secretor” genotype for FUT2 confers resistance to H. Pylori. H. Pylori is present in approximately 50% of the population in developed countries.",
            bullets:
              '["You do not have the non-secretor genotype for FUT2, associated with an average susceptibility to H. Pylori","H. Pylori inhibition has been demonstrated with alcohol extracts of the mushroom Lion\'s Mane"]',
          },
        },
      ],
    },
    {
      menuId: 27,
      title: "COVID-19",
      items: [
        {
          subMenuId: 223,
          name: "SARS-CoV-2 Susceptibility",
          score: 2,
          apoe_name: "3/3",
          selectedOption: {
            title: "AVERAGE",
            description:
              "Genome-wide association studies have identified a region of chromosome 3p21.31 as the for conferring susceptibility to infection with LZTFL1 as the candidate gene. ApoE-e4, ACE2 and TMPRSS2 polymorphisms have been shown to be strongly associated with the susceptibility, severity, and clinical outcomes of COVID-19.",
            bullets:
              '["Your genotype combination is associated with a reduced probability to SARS-CoV-2 infection","Advanced age, obesity, and being male are considered the top risk factors for SARS-CoV-2 susceptibility, especially when combined with Type 2 diabetes, high blood pressure, and cardiovascular disease","Research has shown that CBD, Chaga mushroom, birch bark and olive oil may stop SARS CoV-2 entry by helping block the \\u201clock\\u201d for viral entry","The flavonols kaempferol, quercetin, myricetin, fisetin and their derivatives were the most documented molecules with antiviral activities against SARS-CoV-2","Propolis has antiviral activity and inhibitory effects on ACE2, TMPRSS2 and PAK1 signaling pathways used by SARS-CoV-2, while promoting immunoregulation of pro-inflammatory cytokines, and reducing the risk of cytokine storm syndrome"]',
          },
        },
      ],
    },
    {
      menuId: 2,
      title: "DNA Protection & Repair",
      items: [
        {
          subMenuId: 23,
          name: "Glutathione Protection",
          score: 99,
          apoe_name: "3/3",
          selectedOption: {
            title: "HIGH PRIORITY",
            description:
              "Glutathione is the master antioxidant system involved in oxidative stress, detoxification, and immunity. Glutathione status parallels telomerase activity, an important indicator of lifespan.",
            bullets:
              '["Your genotype combinations are associated with decreased baseline glutathione levels","Glutathione decreases with age, and low levels of glutathione are associated with chronic exposure to chemical toxins, heavy metals and excess alcohol, immunocompromised conditions, and neurodegenerative disorders","Glutathione has been found to increase by 20% with deep breathing practices like Tai Chi or yoga","For exercise, a combination of aerobic exercise and circuit weight training produced the highest glutathione effect","Selenium, glycine, cysteine, vitamin C, and cruciferous vegetables all improve glutathione levels","Chicken or bone broth, herbs, and spices are some of the best dietary ways to maintain higher levels of glutathione","Some of the all-stars include cinnamon, anise, sage, and thyme due to also containing the antiviral compound caffeic acid"]',
          },
        },
      ],
    },
    {
      menuId: 16,
      title: "Methylation",
      items: [
        {
          subMenuId: 99,
          name: "Folate",
          score: 2,
          apoe_name: "3/3",
          selectedOption: {
            title: "AVERAGE NEED",
            description:
              "MTHFR 677 and MTHFR 1298 genotypes determine your folate requirements to assist normal homocysteine levels.",
            bullets:
              '["Your genotype combination is associated with an average requirement for folate to maintain healthy homocysteine levels"]',
          },
        },
      ],
    },
    {
      menuId: 18,
      title: "Hormone Support",
      items: [
        {
          subMenuId: 3,
          name: "Breast Protection",
          score: 50,
          apoe_name: "3/3",
          selectedOption: {
            title: "MEDIUM PRIORITY",
            description: "Certain glutathione SNPs are associated with breast protection.",
            bullets:
              '["Your genotypes for multiple genes are associated with slightly lower glutathione protection for breast health","Boosting glutathione can be accomplished with selenium, glycine, cysteine, vitamin C, and cruciferous vegetables"]',
          },
        },
      ],
    },
    {
      menuId: 20,
      title: "Cardiovascular Health",
      items: [
        {
          subMenuId: 179,
          name: "HDL and LDL",
          score: 2,
          apoe_name: "3/3",
          selectedOption: {
            title: "AVERAGE",
            description:
              "ApoE is connected to HDL and LDL levels, while PON1 is involved with supporting HDL function and LDL oxidation, an important mechanism in atherosclerosis and heart disease.",
            bullets:
              '["Your genotype combination is associated with a higher likelihood of good HDL levels and a lower likelihood of higher levels of LDL, oxidized LDL, and total cholesterol"]',
          },
        },
      ],
    },
    {
      menuId: 13,
      title: "Exercise",
      items: [
        {
          subMenuId: 81,
          name: "Power Athlete Potential",
          score: 99,
          apoe_name: "3/3",
          selectedOption: {
            title: "HIGH",
            description:
              "ACTN3 is currently the most promising gene for predicting the likelihood of becoming an Olympic level sprint and power athlete in males and females. The RR (CC) genotype expresses the ACTN3 protein found in Type II muscle fibers, which produces explosive and powerful contractions.",
            bullets:
              '["You have the RR genotype for the ACTN3 gene associated with more Type II fast-twitch muscle fibers and power","More powerful muscle contractions","Higher muscle hypertrophy response","Faster recovery"]',
          },
        },
      ],
    },
  ],
  epigenetic_scores: [
    {
      epigenetic_submenu_id: 2,
      score: 99,
      apoe_name: "3/3",
    },
    {
      epigenetic_submenu_id: 3,
      score: 50,
      apoe_name: "3/3",
    },
    {
      epigenetic_submenu_id: 6,
      score: 2,
      apoe_name: "3/3",
    },
    {
      epigenetic_submenu_id: 7,
      score: 99,
      apoe_name: "3/3",
    },
    {
      epigenetic_submenu_id: 8,
      score: 2,
      apoe_name: "3/3",
    },
    {
      epigenetic_submenu_id: 9,
      score: 99,
      apoe_name: "3/3",
    },
    {
      epigenetic_submenu_id: 10,
      score: 99,
      apoe_name: "3/3",
    },
    {
      epigenetic_submenu_id: 11,
      score: 50,
      apoe_name: "3/3",
    },
  ],
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

/** Raw-data CSV (`RSID,CHROMOSOME,POSITION,RESULT`), as the simulator publishes it. */
export const RAW_DATA_CSV =
  "RSID,CHROMOSOME,POSITION,RESULT\nrs1801133,1,11796321,CT\nrs1801131,1,11794419,TT\nrs429358,19,45411941,TT\nrs7412,19,45412079,CC\nrs6025,1,169549811,GG\nrs5882,16,57017292,AG\nrs662799,11,116648917,AA\nrs1801282,3,12393125,CC\nrs9939609,16,53820527,AT\nrs7903146,10,114758349,CT\n"

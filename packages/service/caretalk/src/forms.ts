/**
 * The form definitions every namespace starts with, in CareTalk's `fullFormDto` shape (the
 * fields `caretalk-forms.type.ts` declares). Answer types: 1 text, 2 single choice, 3 multiple
 * choice, 4 dropdown, 5 display text: the cases our `transformFormData` switches on.
 */
export type QuestionAnswer = {
  id: number
  answer: string
  freeAnswerText: string | null
  questionId: number
  complexity: number | null
  isChecked: boolean
  updatedAt: string | null
  createdAt: string
  deletedAt: string | null
  description: string | null
}

export type Question = {
  id: number
  questionText: string
  groupId: number
  sectionId: number | null
  answerTypeId: 1 | 2 | 3 | 4 | 5
  alignment: number | null
  answerText: string | null
  answerComplexity: number
  questionOrder: number | null
  isMainQuestion: boolean
  isTrueFalseQuestion: boolean | null
  updatedAt: string
  createdAt: string
  deletedAt: string | null
  tfValue: boolean | null
  caption: string | null
  questionAnswers: QuestionAnswer[]
}

export type FormGroup = {
  id: number
  name: string
  formId: number
  parentGroupId: number | null
  updatedAt: string | null
  createdAt: string
  deletedAt: string | null
  description: string | null
  caption: string | null
  groupQuestions: {
    questionId: number
    groupId: number
    question: Question
    questionOrder: number | null
  }[]
  mainQuestion: { id: number; text: string; type: number } | null
  subGroups: FormGroup[]
}

export type FullFormDto = {
  id: number
  name: string
  isAllowMultible: boolean
  slug: string
  description: string | null
  updatedAt: string
  createdAt: string
  deletedAt: string | null
  groups: FormGroup[]
}

const CREATED = "2025-01-15T00:00:00"

const answer = (
  id: number,
  questionId: number,
  text: string,
  complexity: number | null = null,
): QuestionAnswer => ({
  id,
  answer: text,
  freeAnswerText: null,
  questionId,
  complexity,
  isChecked: false,
  updatedAt: null,
  createdAt: CREATED,
  deletedAt: null,
  description: null,
})

const question = (
  id: number,
  groupId: number,
  text: string,
  answerTypeId: Question["answerTypeId"],
  answers: [number, string, (number | null)?][] = [],
  order = 1,
): Question => ({
  id,
  questionText: text,
  groupId,
  sectionId: null,
  answerTypeId,
  alignment: null,
  answerText: null,
  answerComplexity: 0,
  questionOrder: order,
  isMainQuestion: false,
  isTrueFalseQuestion: null,
  updatedAt: CREATED,
  createdAt: CREATED,
  deletedAt: null,
  tfValue: null,
  caption: null,
  questionAnswers: answers.map(([aid, text2, complexity]) =>
    answer(aid, id, text2, complexity ?? null),
  ),
})

const group = (id: number, formId: number, name: string, questions: Question[]): FormGroup => ({
  id,
  name,
  formId,
  parentGroupId: null,
  updatedAt: null,
  createdAt: CREATED,
  deletedAt: null,
  description: null,
  caption: null,
  groupQuestions: questions.map((q, i) => ({
    questionId: q.id,
    groupId: id,
    question: q,
    questionOrder: i + 1,
  })),
  mainQuestion: null,
  subGroups: [],
})

export const DEFAULT_FORMS: readonly FullFormDto[] = [
  {
    id: 101,
    name: "Health History",
    isAllowMultible: false,
    slug: "health-history",
    description: "Baseline health history for new members",
    updatedAt: CREATED,
    createdAt: CREATED,
    deletedAt: null,
    groups: [
      group(201, 101, "General", [
        question(1001, 201, "Do you currently smoke?", 2, [
          [5001, "Yes"],
          [5002, "No"],
        ]),
        question(
          1002,
          201,
          "Which conditions have you been diagnosed with?",
          3,
          [
            [5003, "Hypertension"],
            [5004, "Diabetes"],
            [5005, "Other", 1],
          ],
          2,
        ),
        question(1003, 201, "List your current medications", 1, [], 3),
      ]),
      group(202, 101, "Before you begin", [
        question(1004, 202, "Answer honestly; your provider reviews every response.", 5),
      ]),
    ],
  },
  {
    id: 102,
    name: "AOE Questions",
    isAllowMultible: true,
    slug: "aoe-questions",
    description: null,
    updatedAt: CREATED,
    createdAt: CREATED,
    deletedAt: null,
    groups: [
      group(203, 102, "Ask on order entry", [
        question(1101, 203, "Are you fasting?", 4, [
          [5101, "Yes"],
          [5102, "No"],
        ]),
      ]),
    ],
  },
]

/** US states in CareTalk's `/externalapi/States` shape. */
const STATES: [string, string][] = [
  ["AL", "Alabama"],
  ["AK", "Alaska"],
  ["AZ", "Arizona"],
  ["AR", "Arkansas"],
  ["CA", "California"],
  ["CO", "Colorado"],
  ["CT", "Connecticut"],
  ["DE", "Delaware"],
  ["DC", "District of Columbia"],
  ["FL", "Florida"],
  ["GA", "Georgia"],
  ["HI", "Hawaii"],
  ["ID", "Idaho"],
  ["IL", "Illinois"],
  ["IN", "Indiana"],
  ["IA", "Iowa"],
  ["KS", "Kansas"],
  ["KY", "Kentucky"],
  ["LA", "Louisiana"],
  ["ME", "Maine"],
  ["MD", "Maryland"],
  ["MA", "Massachusetts"],
  ["MI", "Michigan"],
  ["MN", "Minnesota"],
  ["MS", "Mississippi"],
  ["MO", "Missouri"],
  ["MT", "Montana"],
  ["NE", "Nebraska"],
  ["NV", "Nevada"],
  ["NH", "New Hampshire"],
  ["NJ", "New Jersey"],
  ["NM", "New Mexico"],
  ["NY", "New York"],
  ["NC", "North Carolina"],
  ["ND", "North Dakota"],
  ["OH", "Ohio"],
  ["OK", "Oklahoma"],
  ["OR", "Oregon"],
  ["PA", "Pennsylvania"],
  ["RI", "Rhode Island"],
  ["SC", "South Carolina"],
  ["SD", "South Dakota"],
  ["TN", "Tennessee"],
  ["TX", "Texas"],
  ["UT", "Utah"],
  ["VT", "Vermont"],
  ["VA", "Virginia"],
  ["WA", "Washington"],
  ["WV", "West Virginia"],
  ["WI", "Wisconsin"],
  ["WY", "Wyoming"],
]

export const US_STATES = STATES.map(([abbreviation, name], index) => ({
  id: index + 1,
  stateUid: `st-${abbreviation.toLowerCase()}`,
  name,
  abbreviation,
  physiciansStateLicenseds: [] as unknown[],
  users: [] as unknown[],
  stateLocationCapabilities: [] as unknown[],
}))

/** The physicians whose calendars `GetFreeSlots` answers from. */
export const DEFAULT_DOCTORS = [
  { doctorId: 7, doctorName: "Dr. Ada Mock", medicalSpecialty: "Internal Medicine" },
  { doctorId: 8, doctorName: "Dr. Grace Mock", medicalSpecialty: "Endocrinology" },
] as const

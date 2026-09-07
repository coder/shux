import { expect, test } from "bun:test";
import { parseAskUserQuestionAnswer } from "./parseAskUserQuestionAnswer";

const question = {
  question: "Which branch?",
  header: "Branch",
  options: [
    { label: "main", description: "Stable branch" },
    { label: "next", description: "Upcoming release" },
  ],
  multiSelect: false,
};

test("single-select prefills distinguish exact labels from custom text without splitting commas", () => {
  expect(parseAskUserQuestionAnswer(question, "  main  ")).toEqual({
    optionLabels: ["main"],
    customText: "",
  });
  expect(parseAskUserQuestionAnswer(question, "  MAIN, next  ")).toEqual({
    optionLabels: [],
    customText: "MAIN, next",
  });
  expect(
    parseAskUserQuestionAnswer(
      {
        ...question,
        options: [...question.options, { label: "main, next", description: "Both branches" }],
      },
      "main, next"
    )
  ).toEqual({ optionLabels: ["main, next"], customText: "" });
});

test("multi-select keeps desktop ordering and duplicates while combining custom fragments", () => {
  expect(
    parseAskUserQuestionAnswer(
      { ...question, multiSelect: true },
      " next, , custom one, main, custom two, next "
    )
  ).toEqual({
    optionLabels: ["next", "main", "next"],
    customText: "custom one, custom two",
  });
});

test("blank answers and empty multi-select tokens do not create an Other selection", () => {
  expect(parseAskUserQuestionAnswer(question, " \n ")).toEqual({
    optionLabels: [],
    customText: "",
  });
  expect(parseAskUserQuestionAnswer({ ...question, multiSelect: true }, " , , ")).toEqual({
    optionLabels: [],
    customText: "",
  });
});

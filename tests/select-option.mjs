export async function openSelect(trigger) {
  await trigger.click();
  const list = trigger.page().getByRole("listbox");
  await list.waitFor();
  return list;
}

export async function chooseSelectOption(trigger, label) {
  const list = await openSelect(trigger);
  await list.getByRole("option", { name: label, exact: true }).click();
}

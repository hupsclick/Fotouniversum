"use strict";
(function () {
  const trigger = document.getElementById("coffeeTrigger");
  const modal = document.getElementById("coffeeModal");
  const close = document.getElementById("coffeeClose");
  function open() { modal.classList.add("is-open"); modal.setAttribute("aria-hidden", "false"); close.focus(); }
  function shut() { modal.classList.remove("is-open"); modal.setAttribute("aria-hidden", "true"); trigger.focus(); }
  trigger.addEventListener("click", open);
  close.addEventListener("click", shut);
  modal.addEventListener("click", e => { if (e.target === modal) shut(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && modal.classList.contains("is-open")) shut(); });
})();

const MODES = {
  work: {
    label: "Работа 💼",
    description: "Умар сейчас на работе и занят",
    prompt: "Umar is currently at work and occupied with business tasks. He will respond when he has a free moment.",
  },
  sleep: {
    label: "Сон 😴",
    description: "Умар спит",
    prompt: "Umar is currently sleeping and will respond in the morning. Be gentle and brief.",
  },
  rest: {
    label: "Отдых 🌴",
    description: "Умар отдыхает",
    prompt: "Umar is currently resting and taking personal time. He will respond later.",
  },
  meeting: {
    label: "Встреча 🤝",
    description: "Умар на встрече",
    prompt: "Umar is currently in a meeting. He will respond as soon as it ends. Take note of any questions or requests.",
  },
  free: {
    label: "Свободен ✅",
    description: "Умар скоро освободится",
    prompt: "Umar will be available shortly. Be warm, take messages and questions carefully.",
  },
  dnd: {
    label: "Не беспокоить 🔕",
    description: "Умар просит не беспокоить",
    prompt: "Umar has requested not to be disturbed. Only accept truly urgent messages and note everything else for later.",
  },
};

function getSuggestedMode() {
  const hour = new Date().getHours();
  if (hour >= 23 || hour < 8) return "sleep";
  if (hour >= 9 && hour < 19) return "work";
  return "rest";
}

module.exports = { MODES, getSuggestedMode };

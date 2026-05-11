const { loadStore, mutateStore } = require('./dataStore');
const { refreshAiProfileSummary } = require('./chatService');

function getProfileState() {
  const store = loadStore();
  return store.profile;
}

async function updateUserProfile(input) {
  const now = new Date().toISOString();
  const next = await mutateStore((store) => {
    for (const key of Object.keys(store.profile.userProfile)) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        store.profile.userProfile[key] = String(input[key] || '');
      }
    }
    store.profile.metadata.lastManualUpdateAt = now;
    return store.profile;
  });

  if (Object.values(input || {}).some(Boolean)) {
    refreshAiProfileSummary().catch((error) => {
      console.error('[PROFILE] AI 프로필 갱신 실패:', error.message);
    });
  }

  return next;
}

module.exports = {
  getProfileState,
  updateUserProfile,
};

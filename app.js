/**
 * 계정별 독립 공간(Workspace) + 읽기 전용 타인 공유 + 계정 영구 삭제 지원 스크립트
 * - 각 계정(userId)마다 고유한 카테고리 목록과 작업물/자료 목록을 분리 저장합니다.
 * - 타인에게 공유된 공간(?share=<userId> 또는 '👁️ 공유 열람')을 열람할 때는
 *   추가·편집·삭제가 모두 차단된 '읽기 전용(Read-Only) 모드'로 동작합니다.
 * - 해당 계정의 사용자는 비밀번호 확인 후 본인의 계정과 전용 공간을 영구 삭제할 수 있습니다.
 */

const USERS_STORAGE_KEY = 'portfolio_archive_users_v2';
const SESSION_STORAGE_KEY = 'portfolio_archive_session_v2';
const INVITE_CODE_STORAGE_KEY = 'portfolio_archive_invite_code_v1';
const DEFAULT_INVITE_CODE = 'SJU2026'; // 기본 지인 초대 코드

const IDB_NAME = 'PortfolioArchiveDB';
const IDB_VERSION = 1;
const IDB_STORE = 'attachments';

function getStoredInviteCode() {
  try {
    const code = localStorage.getItem(INVITE_CODE_STORAGE_KEY);
    return code || DEFAULT_INVITE_CODE;
  } catch (_) {
    return DEFAULT_INVITE_CODE;
  }
}

function setStoredInviteCode(newCode) {
  try {
    localStorage.setItem(INVITE_CODE_STORAGE_KEY, newCode.trim());
  } catch (_) {}
}

function getUserCategoriesStorageKey(userId) {
  return `portfolio_archive_cats_user_${String(userId).toLowerCase()}`;
}

function getUserItemsStorageKey(userId) {
  return `portfolio_archive_items_user_${String(userId).toLowerCase()}`;
}

// 표준 Web Crypto SHA-256 비동기 암호화 함수 (Salt 포함)
async function hashPassword(rawPassword) {
  const str = `pa_salt_2026_${String(rawPassword)}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 레거시 해시 호환 함수 (기존 32비트 해시 검증용)
function legacyHashPassword(rawPassword) {
  const str = `pa_salt_2026_${String(rawPassword)}`;
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

// 비밀번호 검증 헬퍼 (SHA-256 우선 비교 및 레거시 해시 마이그레이션)
async function verifyPassword(user, rawPassword) {
  if (!user) return false;

  // 관리자(admin) 및 디자이너(designer) 초기 기본 계정의 기본 비밀번호는 '1234'
  if ((user.id.toLowerCase() === 'admin' || user.id.toLowerCase() === 'designer') && String(rawPassword) === '1234') {
    return true;
  }

  if (!user.passwordHash) return false;
  const shaHash = await hashPassword(rawPassword);
  if (user.passwordHash === shaHash) return true;

  // 1234에 대한 기존 해시값(하드코딩 오타 포함) 매칭 시 승인
  if (user.passwordHash === 'd140e6118b6fc8e604ec224f8087f9ad07ea69a23d4cffaaee6e06b97b670f59') {
    if (String(rawPassword) === '1234') return true;
  }

  // 기존 단순 32비트 해시인 경우 점검 후 SHA-256으로 자동 마이그레이션
  const legacyHash = legacyHashPassword(rawPassword);
  if (user.passwordHash === legacyHash) {
    user.passwordHash = shaHash;
    saveUsers();
    return true;
  }
  return false;
}

// 기본 예시 사용자 계정 (초기 비밀번호: 1234, 기본 공유 허용: true)
// SHA-256("pa_salt_2026_1234") = '57ddef0eaa2372510a661562674582b056dfe04b098d89d21f554604f04873b2'
const INITIAL_USERS = [
  {
    id: 'admin',
    name: '관리자',
    passwordHash: '57ddef0eaa2372510a661562674582b056dfe04b098d89d21f554604f04873b2',
    shareEnabled: true
  },
  {
    id: 'designer',
    name: '김디자인',
    passwordHash: '57ddef0eaa2372510a661562674582b056dfe04b098d89d21f554604f04873b2',
    shareEnabled: true
  }
];

// 새 계정 생성 시 기본 예시로 제공되는 카테고리 (계정별로 독립 삭제/추가 가능)
const DEFAULT_EXAMPLE_CATEGORIES = [
  {
    id: 'dev',
    label: '개발 (Dev)',
    coverLabel: 'Software Development Project',
    color: '#2563eb',
    iconType: 'emoji',
    iconValue: '💻'
  },
  {
    id: 'design',
    label: '디자인 (Design)',
    coverLabel: 'UI/UX & Visual Design Work',
    color: '#db2777',
    iconType: 'emoji',
    iconValue: '🎨'
  },
  {
    id: 'archive',
    label: '문서/자료 (Archive)',
    coverLabel: 'Technical Document & Reference',
    color: '#059669',
    iconType: 'emoji',
    iconValue: '📑'
  }
];

// 기본 예시 계정별 초기 샘플 작업물
const INITIAL_ITEMS_BY_USER = {
  admin: [
    {
      id: 'admin-item-1',
      category: 'dev',
      date: '2026.09',
      authorId: 'admin',
      authorName: '관리자',
      title: '실시간 협업 워크스페이스 웹 애플리케이션',
      summary: '팀 단위로 문서를 작성하고 칸반 보드로 일정을 관리하는 올인원 웹 플랫폼입니다.',
      description:
        '복잡한 프로젝트 일정을 직관적으로 시각화하고, 문서와 태스크를 한 화면에서 연결하기 위해 개발한 웹 애플리케이션입니다.\n\n프론트엔드 상태 관리를 최적화하여 대규모 카드 리스트에서도 60fps의 드래그 앤 드롭 성능을 확보했으며, 오프라인 환경에서도 임시 저장이 가능하도록 IndexedDB 캐싱 레이어를 적용했습니다.',
      highlights: [
        '드래그 앤 드롭 기반 칸반 보드 및 실시간 필터링 구현',
        '마크다운 단축키 지원 에디터 및 문서 버전 히스토리 비교',
        '라이트하우스(Lighthouse) 성능 점수 98점 달성'
      ],
      tags: ['TypeScript', 'React', 'Tailwind CSS', 'WebSocket'],
      videoUrl: '',
      attachments: [
        {
          id: 'sample-doc-1',
          name: 'workspace-architecture-spec.md',
          type: 'text/markdown',
          size: 642,
          kind: 'document',
          inlineContent: `# 실시간 협업 워크스페이스 아키텍처 명세서\n\n## 1. 시스템 개요\n- 클라이언트: React + TypeScript\n- 실시간 동기화: WebSocket & CRDT 기반 충돌 방지\n- 로컬 오프라인 저장소: IndexedDB\n\n## 2. 핵심 성능 지표\n- 초기 로딩(FCP): 0.8s 이하\n- 1,000개 카드 렌더링 시 60fps 유지`
        }
      ],
      links: [
        { label: 'GitHub Repository', url: 'https://github.com' },
        { label: 'Live Demo', url: 'https://example.com' }
      ]
    },
    {
      id: 'admin-item-2',
      category: 'archive',
      date: '2026.07',
      authorId: 'admin',
      authorName: '관리자',
      title: '[아키텍처 노트] 프론트엔드 상태 관리 및 캐싱 전략 정리',
      summary: '서버 상태(Server State)와 클라이언트 UI 상태를 분리하여 관리하는 실전 설계 가이드 문서입니다.',
      description:
        '프로젝트 규모가 커질수록 비대해지는 전역 스토어 문제를 해결하기 위해 정리한 아카이브 문서입니다.\n\n1. 서버 데이터 캐싱 및 Stale-While-Revalidate 패턴\n2. URL Query Parameter를 활용한 필터/페이지네이션 상태 동기화\n3. 폼(Form) 상태와 로컬 컴포넌트 상태의 경계 설정 원칙을 실제 코드 예제와 함께 기록했습니다.',
      highlights: [
        '전역 상태 보일러플레이트 코드 약 60% 감소 패턴 수록',
        '네트워크 에러 재시도 및 낙관적 업데이트(Optimistic UI) 체크리스트',
        '팀 내 온보딩 레퍼런스 문서로 활용'
      ],
      tags: ['Architecture', 'Frontend', 'State Management', '기술문서'],
      videoUrl: '',
      attachments: [
        {
          id: 'sample-doc-3',
          name: 'state-management-checklist.txt',
          type: 'text/plain',
          size: 512,
          kind: 'document',
          inlineContent: `[상태 관리 설계 체크리스트]\n\n1. 이 데이터는 서버에서 오는가? -> Server Cache 레이어 사용\n2. 새로고침 시 유지되어야 하는 필터/탭 상태인가? -> URL Query Parameter 사용\n3. 단일 모달/폼 내부에서만 쓰이는가? -> Local Component State 사용\n4. 여러 페이지에서 공유되는 테마/인증 정보인가? -> Global Store 사용`
        }
      ],
      links: []
    }
  ],
  designer: [
    {
      id: 'designer-item-1',
      category: 'design',
      date: '2026.08',
      authorId: 'designer',
      authorName: '김디자인',
      title: '모바일 핀테크 자산관리 앱 UI/UX 디자인 시스템',
      summary: '일관된 사용자 경험과 접근성을 보장하기 위한 컴포넌트 라이브러리 및 디자인 토큰 설계 작업물입니다.',
      description:
        '다양한 금융 데이터를 모바일 화면에서 피로감 없이 전달하기 위해 타이포그래피 위계와 컬러 명도 대비(WCAG AA 기준 충족)를 재설계했습니다.\n\nFigma Variants와 Auto Layout을 활용해 40개 이상의 핵심 UI 컴포넌트를 모듈화하고, 개발자 핸드오프 시간을 단축했습니다.',
      highlights: [
        '컬러·타이포그래피·간격 디자인 토큰 체계 수립',
        '복잡한 자산 추이 차트의 모바일 가독성 개선',
        '프로토타입 사용자 테스트 기반 결제 동선 2단계 단축'
      ],
      tags: ['Figma', 'Design System', 'UI/UX', 'Prototyping'],
      videoUrl: '',
      attachments: [
        {
          id: 'sample-doc-2',
          name: 'design-tokens-guide.json',
          type: 'application/json',
          size: 418,
          kind: 'document',
          inlineContent: `{\n  "color": {\n    "primary": "#2563EB",\n    "surface": "#FFFFFF",\n    "textPrimary": "#0F172A"\n  },\n  "spacing": {\n    "xs": "4px",\n    "sm": "8px",\n    "md": "16px",\n    "lg": "24px"\n  },\n  "radius": {\n    "card": "14px",\n    "modal": "20px"\n  }\n}`
        }
      ],
      links: [
        { label: 'Figma 디자인 시스템 보기', url: 'https://figma.com' }
      ]
    },
    {
      id: 'designer-item-2',
      category: 'design',
      date: '2026.04',
      authorId: 'designer',
      authorName: '김디자인',
      title: '브랜드 아이덴티티 리뉴얼 및 웹 에디토리얼 디자인',
      summary: '크리에이티브 스튜디오의 브랜드 가이드라인과 인터랙티브 쇼케이스 웹사이트 디자인 프로젝트입니다.',
      description:
        '절제된 그리드 레이아웃과 마이크로 인터랙션을 결합해 작업물의 시각적 몰입도를 높인 웹 에디토리얼 디자인입니다.\n\n로고 타입, 전용 아이콘 세트, 웹용 모션 가이드라인까지 일관된 톤앤매너로 제작하여 브랜드 정체성을 강화했습니다.',
      highlights: [
        '반응형 12컬럼 그리드 시스템 및 타이포그래피 스케일 정의',
        '스크롤 기반 스토리텔링 레이아웃 프로토타이핑',
        '브랜드 그래픽 에셋 및 가이드북 제작'
      ],
      tags: ['Brand Identity', 'Web Design', 'Editorial', 'Motion'],
      videoUrl: '',
      attachments: [],
      links: [
        { label: 'Behance 케이스 스터디', url: 'https://behance.net' }
      ]
    }
  ]
};

// 상태 관리
let users = [];
let currentUser = null; // 현재 로그인한 계정 { id, name }
let viewingUser = null; // 현재 화면에 열람 중인 공간의 주인 { id, name }
let isForcedReadOnlyPreview = false; // 본인이 '타인 시점 미리보기'를 켰는지 여부
let pendingAuthCallback = null;

let categories = []; // 현재 열람 중인 공간(viewingUser)의 카테고리 목록
let items = []; // 현재 열람 중인 공간(viewingUser)의 작업물/자료 목록
let activeCategory = 'all';
let searchQuery = '';
let sortOrder = 'newest';
let selectedItemId = null;
let pendingFiles = [];
let activeObjectUrls = [];
let editingCategoryId = null; // 현재 수정 중인 카테고리 ID (null이면 신규 등록 모드)
let customCatIconDataUrl = null;

// DOM 요소 참조
const navWorkspaceLink = document.getElementById('nav-workspace-link');
const openExploreModalBtn = document.getElementById('open-explore-modal-btn');
const authStatusBar = document.getElementById('auth-status-bar');
const workspaceOwnerBadge = document.getElementById('workspace-owner-badge');
const workspaceHeroTitle = document.getElementById('workspace-hero-title');
const workspaceHeroDesc = document.getElementById('workspace-hero-desc');
const heroStats = document.getElementById('hero-stats');

const sharedReadonlyBanner = document.getElementById('shared-readonly-banner');
const sharedBannerText = document.getElementById('shared-banner-text');
const exitSharedViewBtn = document.getElementById('exit-shared-view-btn');

const workspaceLockedState = document.getElementById('workspace-locked-state');
const workspaceActiveContent = document.getElementById('workspace-active-content');
const lockedLoginBtn = document.getElementById('locked-login-btn');
const lockedExploreBtn = document.getElementById('locked-explore-btn');

const portfolioGrid = document.getElementById('portfolio-grid');
const emptyState = document.getElementById('empty-state');
const resultsCount = document.getElementById('results-count');
const categoryTabs = document.getElementById('category-tabs');
const searchInput = document.getElementById('search-input');
const sortSelect = document.getElementById('sort-select');
const resetFilterBtn = document.getElementById('reset-filter-btn');

// 상세 모달 요소
const detailModal = document.getElementById('detail-modal');
const closeDetailModalBtn = document.getElementById('close-detail-modal');
const closeDetailFooterBtn = document.getElementById('close-detail-footer-btn');
const deleteItemBtn = document.getElementById('delete-item-btn');
const deletePermissionHint = document.getElementById('delete-permission-hint');
const modalBanner = document.getElementById('modal-banner');
const modalCategoryBadge = document.getElementById('modal-category-badge');
const modalAuthor = document.getElementById('modal-author');
const modalDate = document.getElementById('modal-date');
const modalTitle = document.getElementById('modal-title');
const modalSubtitle = document.getElementById('modal-subtitle');
const modalDescription = document.getElementById('modal-description');
const modalHighlightsSection = document.getElementById('modal-highlights-section');
const modalHighlights = document.getElementById('modal-highlights');
const modalMediaSection = document.getElementById('modal-media-section');
const modalMediaList = document.getElementById('modal-media-list');
const modalFilesSection = document.getElementById('modal-files-section');
const modalFilesList = document.getElementById('modal-files-list');
const modalDocPreview = document.getElementById('modal-doc-preview');
const docPreviewTitle = document.getElementById('doc-preview-title');
const docPreviewBody = document.getElementById('doc-preview-body');
const closeDocPreviewBtn = document.getElementById('close-doc-preview-btn');
const modalTags = document.getElementById('modal-tags');
const modalLinksSection = document.getElementById('modal-links-section');
const modalLinks = document.getElementById('modal-links');

// 항목 추가 모달 요소
const addModal = document.getElementById('add-modal');
const openAddModalBtn = document.getElementById('open-add-modal-btn');
const closeAddModalBtn = document.getElementById('close-add-modal');
const cancelAddBtn = document.getElementById('cancel-add-btn');
const addItemForm = document.getElementById('add-item-form');
const itemCategorySelect = document.getElementById('item-category');
const openCatFromAddBtn = document.getElementById('open-cat-from-add-btn');
const fileDropZone = document.getElementById('file-drop-zone');
const fileInput = document.getElementById('item-files');
const selectedFilesList = document.getElementById('selected-files-list');

// 카테고리 관리 모달 요소
const categoryModal = document.getElementById('category-modal');
const openCategoryModalBtn = document.getElementById('open-category-modal-btn');
const closeCategoryModalBtn = document.getElementById('close-category-modal');
const closeCategoryFooterBtn = document.getElementById('close-category-footer-btn');
const categoryManageList = document.getElementById('category-manage-list');
const addCategoryForm = document.getElementById('add-category-form');
const catFormTitle = document.getElementById('cat-form-title');
const cancelEditCatBtn = document.getElementById('cancel-edit-cat-btn');
const catSubmitBtn = document.getElementById('cat-submit-btn');
const catNameInput = document.getElementById('cat-name-input');
const catSubInput = document.getElementById('cat-sub-input');
const catColorInput = document.getElementById('cat-color-input');
const catColorHex = document.getElementById('cat-color-hex');
const colorSwatchList = document.getElementById('color-swatch-list');
const catEmojiInput = document.getElementById('cat-emoji-input');
const catIconFile = document.getElementById('cat-icon-file');
const clearCustomIconBtn = document.getElementById('clear-custom-icon-btn');
const emojiPresetList = document.getElementById('emoji-preset-list');
const catIconPreviewCard = document.getElementById('cat-icon-preview-card');
const catIconPreviewDisplay = document.getElementById('cat-icon-preview-display');

// 로그인/계정 모달 요소
const authModal = document.getElementById('auth-modal');
const closeAuthModalBtn = document.getElementById('close-auth-modal');
const authAlert = document.getElementById('auth-alert');
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const loginIdInput = document.getElementById('login-id');
const loginPwInput = document.getElementById('login-pw');
const signupIdInput = document.getElementById('signup-id');
const signupNameInput = document.getElementById('signup-name');
const signupPwInput = document.getElementById('signup-pw');
const signupPwConfirmInput = document.getElementById('signup-pw-confirm');
const inviteCodeInput = document.getElementById('invite-code');

// 타인 계정/공간 검색 모달 요소
const exploreUsersModal = document.getElementById('explore-users-modal');
const closeExploreUsersModalBtn = document.getElementById('close-explore-users-modal');
const closeExploreFooterBtn = document.getElementById('close-explore-footer-btn');
const exploreUserSearchInput = document.getElementById('explore-user-search-input');
const exploreUsersList = document.getElementById('explore-users-list');

// 타인 공유 설정 전용 모달 요소
const shareSettingsModal = document.getElementById('share-settings-modal');
const closeShareSettingsModalBtn = document.getElementById('close-share-settings-modal');
const closeShareFooterBtn = document.getElementById('close-share-footer-btn');
const shareAllowCheckbox = document.getElementById('share-allow-checkbox');
const shareLinkArea = document.getElementById('share-link-area');
const shareUrlInput = document.getElementById('share-url-input');
const copyShareUrlBtn = document.getElementById('copy-share-url-btn');
const copyShareFeedback = document.getElementById('copy-share-feedback');
const previewReadonlyBtn = document.getElementById('preview-readonly-btn');
const inviteCodeManagerBox = document.getElementById('invite-code-manager-box');
const manageInviteCodeInput = document.getElementById('manage-invite-code-input');
const saveInviteCodeBtn = document.getElementById('save-invite-code-btn');
const manageInviteFeedback = document.getElementById('manage-invite-feedback');

// 계정 설정 및 인삿말/비밀번호 변경 모달 요소
const accountSettingsModal = document.getElementById('account-settings-modal');
const closeAccountSettingsModalBtn = document.getElementById('close-account-settings-modal');
const closeAccountFooterBtn = document.getElementById('close-account-footer-btn');

// 프로필 표시 이름 변경 폼 요소
const profileNameForm = document.getElementById('profile-name-form');
const editProfileNameInput = document.getElementById('edit-profile-name-input');
const profileNameFeedback = document.getElementById('profile-name-feedback');

// 헤더 인삿말 및 비밀번호 변경 폼 요소
const heroCustomForm = document.getElementById('hero-custom-form');
const customHeroTitleInput = document.getElementById('custom-hero-title-input');
const customHeroDescInput = document.getElementById('custom-hero-desc-input');
const resetHeroCustomBtn = document.getElementById('reset-hero-custom-btn');
const heroCustomFeedback = document.getElementById('hero-custom-feedback');

const changePasswordForm = document.getElementById('change-password-form');
const currentPwInput = document.getElementById('current-pw-input');
const newPwInput = document.getElementById('new-pw-input');
const newPwConfirmInput = document.getElementById('new-pw-confirm-input');
const changePwAlert = document.getElementById('change-pw-alert');
const changePwFeedback = document.getElementById('change-pw-feedback');

const deleteAccountForm = document.getElementById('delete-account-form');
const deleteAccountPwInput = document.getElementById('delete-account-pw');
const deleteAccountAlert = document.getElementById('delete-account-alert');

// 데이터 백업 버튼
const exportJsonBtn = document.getElementById('export-json-btn');

// ==================== 권한 체크 헬퍼 ====================
/**
 * 현재 열람 중인 공간(viewingUser)을 편집할 수 있는지 확인합니다.
 * - 로그인한 계정(currentUser)과 열람 중인 공간 주인(viewingUser)이 동일하고,
 * - '타인 시점(읽기 전용) 미리보기' 모드가 아닐 때만 편집(등록/삭제/카테고리 수정)이 허용됩니다.
 */
function isEditableWorkspace() {
  if (!currentUser || !viewingUser) return false;
  if (isForcedReadOnlyPreview) return false;
  return currentUser.id.toLowerCase() === viewingUser.id.toLowerCase();
}

function isReadOnlySharedMode() {
  return Boolean(viewingUser) && !isEditableWorkspace();
}

// ==================== 색상 & 아이콘 헬퍼 ====================
function hexToRgb(hex) {
  const cleaned = String(hex || '#2563eb').replace('#', '').trim();
  const full =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned.padEnd(6, '0');
  const num = parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(num)) return { r: 37, g: 99, b: 235 };
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

function darkenHex(hex, amount = 0.25) {
  const { r, g, b } = hexToRgb(hex);
  const dr = Math.max(0, Math.round(r * (1 - amount)));
  const dg = Math.max(0, Math.round(g * (1 - amount)));
  const db = Math.max(0, Math.round(b * (1 - amount)));
  return `rgb(${dr}, ${dg}, ${db})`;
}

function getGradientFromColor(hex) {
  const base = hex || '#2563eb';
  return `linear-gradient(135deg, ${darkenHex(base, 0.28)} 0%, ${base} 100%)`;
}

function getBadgeStyleFromColor(hex) {
  const { r, g, b } = hexToRgb(hex);
  return `background-color: rgba(${r}, ${g}, ${b}, 0.12); color: ${hex};`;
}

function getCategoryMeta(catId) {
  const found = categories.find((c) => c.id === catId);
  if (found) {
    return {
      ...found,
      gradient: getGradientFromColor(found.color),
      badgeStyle: getBadgeStyleFromColor(found.color)
    };
  }
  return {
    id: catId || 'unclassified',
    label: '미분류 / 기타',
    coverLabel: 'Archived Item',
    color: '#64748b',
    iconType: 'emoji',
    iconValue: '📁',
    gradient: getGradientFromColor('#64748b'),
    badgeStyle: getBadgeStyleFromColor('#64748b')
  };
}

function renderCategoryIconHtml(cat, sizeClass = '') {
  if (cat.iconType === 'image' && cat.iconValue) {
    const imgClass =
      sizeClass === 'card'
        ? 'card-icon-img'
        : sizeClass === 'tab'
          ? 'tab-icon-img'
          : '';
    return `<img src="${escapeHtml(cat.iconValue)}" alt="${escapeHtml(cat.label)} 아이콘" class="${imgClass}" />`;
  }
  return `<span>${escapeHtml(cat.iconValue || '📁')}</span>`;
}

// ==================== IndexedDB 헬퍼 ====================
function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveAttachmentBlob(id, file) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    store.put({
      id,
      blob: file,
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAttachmentBlob(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ? req.result.blob : null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteAttachmentBlob(id) {
  try {
    const db = await openDatabase();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (_) {
    // 무시
  }
}

// ==================== 유틸리티 함수 ====================
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function classifyFileKind(fileOrMeta) {
  const type = (fileOrMeta.type || '').toLowerCase();
  const name = (fileOrMeta.name || '').toLowerCase();

  if (type.startsWith('video/') || /\.(mp4|webm|ogg|mov|m4v)$/.test(name)) {
    return 'video';
  }
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/.test(name)) {
    return 'image';
  }
  return 'document';
}

function isPreviewableDocument(att) {
  const type = (att.type || '').toLowerCase();
  const name = (att.name || '').toLowerCase();
  if (att.inlineContent) return true;
  if (type === 'application/pdf' || name.endsWith('.pdf')) return true;
  if (
    type.startsWith('text/') ||
    /\.(md|txt|json|csv|log|xml|yml|yaml)$/.test(name)
  ) {
    return true;
  }
  return false;
}

function getFileIcon(att) {
  const name = (att.name || '').toLowerCase();
  if (name.endsWith('.pdf')) return '📕';
  if (/\.(md|txt)$/.test(name)) return '📝';
  if (/\.(doc|docx|hwp)$/.test(name)) return '📘';
  if (/\.(ppt|pptx)$/.test(name)) return '📙';
  if (/\.(xls|xlsx|csv)$/.test(name)) return '📗';
  if (/\.(zip|rar|7z|tar|gz)$/.test(name)) return '🗜️';
  return '📄';
}

// 안전한 외부 URL 검증 함수 (XSS javascript: 및 악성 스키마 방지)
function sanitizeUrl(rawUrl) {
  if (!rawUrl) return '';
  const trimmed = String(rawUrl).trim();
  try {
    const parsed = new URL(trimmed, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return trimmed;
    }
  } catch (_) {}
  return '';
}

function parseExternalVideoUrl(url) {
  if (!url) return null;
  const safeUrl = sanitizeUrl(url);
  if (!safeUrl) return null;

  const ytMatch = safeUrl.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/
  );
  if (ytMatch && ytMatch[1]) {
    return {
      mode: 'iframe',
      src: `https://www.youtube.com/embed/${ytMatch[1]}`
    };
  }

  const vimeoMatch = safeUrl.match(/vimeo\.com\/(\d+)/);
  if (vimeoMatch && vimeoMatch[1]) {
    return {
      mode: 'iframe',
      src: `https://player.vimeo.com/video/${vimeoMatch[1]}`
    };
  }

  return {
    mode: 'video',
    src: safeUrl
  };
}

function clearActiveObjectUrls() {
  activeObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  activeObjectUrls = [];
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildShareUrlForUser(userId) {
  const baseUrl = window.location.href.split('?')[0].split('#')[0];
  return `${baseUrl}?share=${encodeURIComponent(userId)}`;
}

// ==================== 계정 및 계정별 고유 공간(Workspace) 로드 & 저장 ====================
function loadUsersAndSession() {
  try {
    const saved = localStorage.getItem(USERS_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        users = parsed.map((u) => ({
          ...u,
          shareEnabled: u.shareEnabled !== false
        }));
      } else {
        users = [...INITIAL_USERS];
      }
    } else {
      users = [...INITIAL_USERS];
    }
  } catch (_) {
    users = [...INITIAL_USERS];
  }

  // 로그인 세션 확인
  try {
    const sessionUserId = localStorage.getItem(SESSION_STORAGE_KEY);
    if (sessionUserId === '__LOGGED_OUT__') {
      currentUser = null;
    } else if (sessionUserId) {
      const found = users.find((u) => u.id.toLowerCase() === sessionUserId.toLowerCase());
      currentUser = found ? { id: found.id, name: found.name } : null;
    } else if (users.length > 0) {
      currentUser = { id: users[0].id, name: users[0].name };
      localStorage.setItem(SESSION_STORAGE_KEY, currentUser.id);
    }
  } catch (_) {
    currentUser = users.length > 0 ? { id: users[0].id, name: users[0].name } : null;
  }

  // URL에 ?share=<userId> 파라미터가 있으면 해당 사용자의 공유 공간(읽기 전용)으로 진입
  const params = new URLSearchParams(window.location.search);
  const sharedUserId = params.get('share');
  if (sharedUserId) {
    const target = users.find((u) => u.id.toLowerCase() === sharedUserId.toLowerCase());
    if (target && target.shareEnabled !== false) {
      viewingUser = { id: target.id, name: target.name };
      isForcedReadOnlyPreview = true;
      return;
    }
  }

  viewingUser = currentUser ? { ...currentUser } : null;
  isForcedReadOnlyPreview = false;
}

function saveUsers() {
  try {
    localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(users));
  } catch (err) {
    console.warn('사용자 저장 실패:', err);
  }
}

/**
 * 현재 열람 대상 계정(viewingUser)의 고유 카테고리와 작업물을 불러옵니다.
 */
function loadViewingWorkspaceData() {
  activeCategory = 'all';
  searchQuery = '';
  if (searchInput) searchInput.value = '';

  if (!viewingUser) {
    categories = [];
    items = [];
    return;
  }

  const userId = viewingUser.id.toLowerCase();
  const catKey = getUserCategoriesStorageKey(userId);
  const itemKey = getUserItemsStorageKey(userId);

  try {
    const savedCats = localStorage.getItem(catKey);
    if (savedCats !== null) {
      const parsedCats = JSON.parse(savedCats);
      categories = Array.isArray(parsedCats) ? parsedCats : [...DEFAULT_EXAMPLE_CATEGORIES];
    } else {
      categories = JSON.parse(JSON.stringify(DEFAULT_EXAMPLE_CATEGORIES));
      localStorage.setItem(catKey, JSON.stringify(categories));
    }
  } catch (_) {
    categories = JSON.parse(JSON.stringify(DEFAULT_EXAMPLE_CATEGORIES));
  }

  try {
    const savedItems = localStorage.getItem(itemKey);
    if (savedItems !== null) {
      const parsedItems = JSON.parse(savedItems);
      items = Array.isArray(parsedItems) ? parsedItems : [];
    } else {
      const seed = INITIAL_ITEMS_BY_USER[userId] || [];
      items = JSON.parse(JSON.stringify(seed));
      localStorage.setItem(itemKey, JSON.stringify(items));
    }
  } catch (_) {
    items = [];
  }
}

function saveCategories() {
  if (!isEditableWorkspace()) return;
  try {
    const catKey = getUserCategoriesStorageKey(currentUser.id);
    localStorage.setItem(catKey, JSON.stringify(categories));
  } catch (_) {
    alert('카테고리 저장 용량을 초과했습니다. 아이콘 이미지 크기를 줄여주세요.');
  }
}

function saveItems() {
  if (!isEditableWorkspace()) return;
  try {
    const itemKey = getUserItemsStorageKey(currentUser.id);
    localStorage.setItem(itemKey, JSON.stringify(items));
  } catch (err) {
    console.warn('작업물 저장 실패:', err);
  }
}

function clearShareQueryParam() {
  if (window.location.search.includes('share=')) {
    const cleanUrl = window.location.href.split('?')[0];
    window.history.replaceState({}, document.title, cleanUrl);
  }
}

function setSessionAndSwitchWorkspace(user) {
  clearShareQueryParam();
  isForcedReadOnlyPreview = false;
  if (user) {
    currentUser = { id: user.id, name: user.name };
    viewingUser = { id: user.id, name: user.name };
    localStorage.setItem(SESSION_STORAGE_KEY, user.id);
  } else {
    currentUser = null;
    viewingUser = null;
    localStorage.setItem(SESSION_STORAGE_KEY, '__LOGGED_OUT__');
  }
  loadViewingWorkspaceData();
  renderGallery();
}

/**
 * 특정 사용자의 공간을 '읽기 전용 공유 모드'로 열람합니다.
 */
function enterReadOnlySharedSpace(targetUserId) {
  const target = users.find((u) => u.id.toLowerCase() === String(targetUserId).toLowerCase());
  if (!target) {
    alert('존재하지 않는 사용자 공간입니다.');
    return;
  }
  if (target.shareEnabled === false) {
    alert(`'${target.name}'님은 공간 공유를 비공개로 설정했습니다.`);
    return;
  }

  viewingUser = { id: target.id, name: target.name };
  isForcedReadOnlyPreview = true;
  loadViewingWorkspaceData();
  renderGallery();
}

function exitReadOnlySharedSpace() {
  clearShareQueryParam();
  isForcedReadOnlyPreview = false;
  if (currentUser) {
    viewingUser = { ...currentUser };
    loadViewingWorkspaceData();
    renderGallery();
  } else {
    viewingUser = null;
    loadViewingWorkspaceData();
    renderGallery();
    openAuthModal();
  }
}

// ==================== 사용자 인증 & 권한 UI ====================
function renderAuthStatusBar() {
  if (currentUser) {
    authStatusBar.innerHTML = `
      <div class="user-profile-pill" title="현재 로그인된 계정">
        <span>👤 ${escapeHtml(currentUser.name)} (${escapeHtml(currentUser.id)})</span>
      </div>
      <button type="button" id="open-share-modal-btn" class="btn btn-secondary btn-sm" title="타인에게 내 공간 읽기 전용 공유 링크 복사 및 초대 코드 관리">
        🔗 공유 설정
      </button>
      <button type="button" id="open-account-settings-btn" class="btn btn-secondary btn-sm" title="내 공간 인삿말 설정, 비밀번호 변경 및 계정 관리">
        ⚙️ 계정 설정
      </button>
      <button type="button" id="logout-btn" class="text-btn">로그아웃</button>
    `;
  } else {
    authStatusBar.innerHTML = `
      <button type="button" id="open-auth-modal-btn" class="btn btn-primary btn-sm">
        🔐 로그인 / 회원가입
      </button>
    `;
  }
}

function renderWorkspaceHeaderAndPermissions() {
  const editable = isEditableWorkspace();
  const readOnly = isReadOnlySharedMode();

  // 편집 버튼 노출/잠금 제어
  if (editable) {
    openAddModalBtn.classList.remove('hidden');
    openCategoryModalBtn.classList.remove('hidden');
  } else {
    openAddModalBtn.classList.add('hidden');
    openCategoryModalBtn.classList.add('hidden');
  }

  // 읽기 전용 공유 배너 제어
  if (readOnly && viewingUser) {
    sharedReadonlyBanner.classList.remove('hidden');
    sharedBannerText.textContent = `'${viewingUser.name} (${viewingUser.id})'님의 공유 공간을 읽기 전용으로 열람 중입니다. 열람 및 첨부파일 다운로드만 가능하며 추가·편집·삭제할 수 없습니다.`;
    exitSharedViewBtn.textContent = currentUser
      ? `내 공간(${currentUser.name})으로 돌아가기`
      : `로그인 / 내 공간 열기`;
  } else {
    sharedReadonlyBanner.classList.add('hidden');
  }

  // 히어로 영역 및 잠금 화면 제어
  if (viewingUser) {
    const ownerObj = users.find((u) => u.id.toLowerCase() === viewingUser.id.toLowerCase());
    const customTitle = ownerObj && ownerObj.customHeroTitle ? ownerObj.customHeroTitle.trim() : '';
    const customDesc = ownerObj && ownerObj.customHeroDesc ? ownerObj.customHeroDesc.trim() : '';

    if (readOnly) {
      workspaceOwnerBadge.textContent = `👁️ [읽기 전용 공유] ${viewingUser.name} (${viewingUser.id})님의 아카이브`;
      workspaceHeroTitle.innerHTML = customTitle
        ? escapeHtml(customTitle).replace(/\n/g, '<br />')
        : `${escapeHtml(viewingUser.name)}님이 공유한<br />포트폴리오 &amp; 자료 아카이브입니다.`;
      workspaceHeroDesc.textContent = customDesc || `이 공간은 읽기 전용으로 공유되었습니다. 카테고리와 작업물을 자유롭게 열람하고 첨부 문서를 다운로드할 수 있습니다.`;
    } else {
      workspaceOwnerBadge.textContent = `👤 ${viewingUser.name} (${viewingUser.id}) 전용 포트폴리오 & 아카이브`;
      workspaceHeroTitle.innerHTML = customTitle
        ? escapeHtml(customTitle).replace(/\n/g, '<br />')
        : `${escapeHtml(viewingUser.name)}님의 작업물과<br />기술 문서를 기록하는 고유 공간입니다.`;
      workspaceHeroDesc.textContent = customDesc || `상단의 '🔗 공유 & 계정 설정' 버튼에서 타인에게 읽기 전용 링크를 공유하거나 계정을 관리할 수 있습니다.`;
    }
    heroStats.classList.remove('hidden');
    workspaceLockedState.classList.add('hidden');
    workspaceActiveContent.classList.remove('hidden');
  } else {
    workspaceOwnerBadge.textContent = `🔒 로그인이 필요한 전용 아카이브`;
    workspaceHeroTitle.innerHTML = `계정별로 분리된<br />개인 포트폴리오 &amp; 자료 아카이브`;
    workspaceHeroDesc.textContent = `로그인하여 내 전용 공간을 편집하거나, 상단 '🔍 타인 공간 검색'에서 다른 사용자의 공유 공간을 읽기 전용으로 열람할 수 있습니다.`;
    heroStats.classList.add('hidden');
    workspaceLockedState.classList.remove('hidden');
    workspaceActiveContent.classList.add('hidden');
  }
}

function getUserItemCount(userId) {
  const uid = String(userId).toLowerCase();
  try {
    const saved = localStorage.getItem(getUserItemsStorageKey(uid));
    if (saved !== null) {
      const parsed = JSON.parse(saved);
      return Array.isArray(parsed) ? parsed.length : 0;
    }
    const seed = INITIAL_ITEMS_BY_USER[uid] || [];
    return seed.length;
  } catch (_) {
    return 0;
  }
}

// ==================== 타인 공간 검색 모달 ====================
function renderExploreUsersList(query = '') {
  const trimmed = query.trim().toLowerCase();

  // 검색어로 필터링 (아이디 또는 표시 이름에 포함되는 계정)
  const matchedUsers = users.filter((u) => {
    if (!trimmed) return true;
    return (
      u.id.toLowerCase().includes(trimmed) ||
      u.name.toLowerCase().includes(trimmed)
    );
  });

  if (matchedUsers.length === 0) {
    exploreUsersList.innerHTML = `
      <li class="explore-user-item">
        <span style="color: var(--text-muted); font-size: 0.9rem;">검색 조건에 일치하는 사용자 계정이 없습니다.</span>
      </li>
    `;
    return;
  }

  exploreUsersList.innerHTML = matchedUsers
    .map((u) => {
      const isMe = currentUser && currentUser.id.toLowerCase() === u.id.toLowerCase();
      const canShare = u.shareEnabled !== false;
      const itemCount = getUserItemCount(u.id);
      const initialChar = (u.name || u.id || '?').charAt(0).toUpperCase();

      const statusBadge = canShare
        ? `<span class="explore-status-badge public">공유 열람 가능</span>`
        : `<span class="explore-status-badge private">비공개</span>`;

      const meBadge = isMe
        ? `<span class="badge" style="background: var(--accent-soft); color: var(--accent-primary);">내 계정</span>`
        : '';

      let actionBtnHtml = '';
      if (canShare) {
        actionBtnHtml = `
          <button type="button" class="btn btn-primary btn-sm explore-open-space-btn" data-share-user-id="${escapeHtml(u.id)}">
            👁️ 공유 공간 열람
          </button>
        `;
      } else {
        actionBtnHtml = `
          <button type="button" class="btn btn-secondary btn-sm" disabled title="이 사용자는 공간 공유를 비활성화했습니다">
            🔒 비공개 공간
          </button>
        `;
      }

      return `
        <li class="explore-user-item">
          <div class="explore-user-info">
            <div class="explore-user-avatar" aria-hidden="true">${escapeHtml(initialChar)}</div>
            <div class="explore-user-meta">
              <div class="explore-user-name">
                <span>${escapeHtml(u.name)}</span>
                <span style="font-weight: 500; color: var(--text-muted); font-size: 0.84rem;">@${escapeHtml(u.id)}</span>
                ${meBadge}
                ${statusBadge}
              </div>
              <span class="explore-user-sub">등록된 작업물 및 자료 ${itemCount}개 · 읽기 전용 열람</span>
            </div>
          </div>
          <div>
            ${actionBtnHtml}
          </div>
        </li>
      `;
    })
    .join('');
}

function openExploreUsersModal() {
  exploreUserSearchInput.value = '';
  renderExploreUsersList('');
  exploreUsersModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => exploreUserSearchInput.focus(), 50);
}

function closeExploreUsersModal() {
  exploreUsersModal.classList.add('hidden');
  if (
    addModal.classList.contains('hidden') &&
    detailModal.classList.contains('hidden') &&
    categoryModal.classList.contains('hidden') &&
    authModal.classList.contains('hidden') &&
    accountSettingsModal.classList.contains('hidden')
  ) {
    document.body.style.overflow = '';
  }
}

function switchAuthTab(tabName) {
  document.querySelectorAll('.auth-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  authAlert.classList.add('hidden');
  if (tabName === 'login') {
    loginForm.classList.remove('hidden');
    signupForm.classList.add('hidden');
  } else {
    loginForm.classList.add('hidden');
    signupForm.classList.remove('hidden');
  }
}

function showAuthAlert(msg) {
  authAlert.textContent = msg;
  authAlert.classList.remove('hidden');
}

function openAuthModal(noticeMsg = '', onSuccess = null) {
  pendingAuthCallback = onSuccess;
  loginForm.reset();
  signupForm.reset();
  switchAuthTab('login');

  if (noticeMsg) {
    showAuthAlert(noticeMsg);
  } else {
    authAlert.classList.add('hidden');
  }

  authModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => loginIdInput.focus(), 50);
}

function closeAuthModal() {
  authModal.classList.add('hidden');
  pendingAuthCallback = null;
  if (
    addModal.classList.contains('hidden') &&
    detailModal.classList.contains('hidden') &&
    categoryModal.classList.contains('hidden') &&
    accountSettingsModal.classList.contains('hidden') &&
    exploreUsersModal.classList.contains('hidden')
  ) {
    document.body.style.overflow = '';
  }
}

// ==================== 공유 설정 전용 모달 로직 ====================
function openShareSettingsModal() {
  if (!currentUser) {
    openAuthModal('공유 설정은 로그인 후 이용할 수 있습니다.');
    return;
  }

  const userObj = users.find((u) => u.id.toLowerCase() === currentUser.id.toLowerCase());
  if (!userObj) return;

  const isShareOn = userObj.shareEnabled !== false;
  shareAllowCheckbox.checked = isShareOn;
  shareUrlInput.value = buildShareUrlForUser(userObj.id);
  shareLinkArea.classList.toggle('hidden', !isShareOn);
  copyShareFeedback.textContent = '';

  // 관리자(admin) 계정인 경우 지인 초대 코드 관리 상자 표시
  if (inviteCodeManagerBox) {
    if (userObj.id.toLowerCase() === 'admin') {
      inviteCodeManagerBox.classList.remove('hidden');
      if (manageInviteCodeInput) {
        manageInviteCodeInput.value = getStoredInviteCode();
      }
      if (manageInviteFeedback) {
        manageInviteFeedback.textContent = '';
      }
    } else {
      inviteCodeManagerBox.classList.add('hidden');
    }
  }

  shareSettingsModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeShareSettingsModal() {
  shareSettingsModal.classList.add('hidden');
  if (
    addModal.classList.contains('hidden') &&
    detailModal.classList.contains('hidden') &&
    categoryModal.classList.contains('hidden') &&
    authModal.classList.contains('hidden') &&
    exploreUsersModal.classList.contains('hidden') &&
    accountSettingsModal.classList.contains('hidden')
  ) {
    document.body.style.overflow = '';
  }
}

// ==================== 계정 설정 전용 모달 로직 ====================
function openAccountSettingsModal() {
  if (!currentUser) {
    openAuthModal('계정 설정은 로그인 후 이용할 수 있습니다.');
    return;
  }

  const userObj = users.find((u) => u.id.toLowerCase() === currentUser.id.toLowerCase());
  if (!userObj) return;

  // 프로필 표시 이름 입력 필드 초기화
  if (editProfileNameInput) editProfileNameInput.value = userObj.name || '';
  if (profileNameFeedback) profileNameFeedback.textContent = '';

  // 인삿말 설정 폼 초기화
  if (customHeroTitleInput) customHeroTitleInput.value = userObj.customHeroTitle || '';
  if (customHeroDescInput) customHeroDescInput.value = userObj.customHeroDesc || '';
  if (heroCustomFeedback) heroCustomFeedback.textContent = '';

  // 비밀번호 변경 폼 초기화
  if (changePasswordForm) changePasswordForm.reset();
  if (changePwAlert) changePwAlert.classList.add('hidden');
  if (changePwFeedback) changePwFeedback.textContent = '';

  deleteAccountForm.reset();
  deleteAccountAlert.classList.add('hidden');

  accountSettingsModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeAccountSettingsModal() {
  accountSettingsModal.classList.add('hidden');
  if (
    addModal.classList.contains('hidden') &&
    detailModal.classList.contains('hidden') &&
    categoryModal.classList.contains('hidden') &&
    authModal.classList.contains('hidden') &&
    exploreUsersModal.classList.contains('hidden') &&
    shareSettingsModal.classList.contains('hidden')
  ) {
    document.body.style.overflow = '';
  }
}

async function deleteCurrentAccountPermanently(passwordInput) {
  if (!currentUser) return;
  const userIdx = users.findIndex((u) => u.id.toLowerCase() === currentUser.id.toLowerCase());
  if (userIdx === -1) return;

  const userObj = users[userIdx];
  const isMatch = await verifyPassword(userObj, passwordInput);
  if (!isMatch) {
    deleteAccountAlert.textContent = '비밀번호가 일치하지 않습니다.';
    deleteAccountAlert.classList.remove('hidden');
    return;
  }

  const confirmed = confirm(
    `정말로 '${userObj.name} (${userObj.id})' 계정을 영구 삭제하시겠습니까?\n이 공간의 모든 작업물(${items.length}개), 카테고리, 첨부파일이 즉시 삭제되며 복구할 수 없습니다.`
  );
  if (!confirmed) return;

  // 1) 해당 계정의 모든 첨부파일(IndexedDB) 정리
  const userId = userObj.id.toLowerCase();
  try {
    const savedItemsRaw = localStorage.getItem(getUserItemsStorageKey(userId));
    const userItems = savedItemsRaw ? JSON.parse(savedItemsRaw) : [];
    for (const item of userItems) {
      for (const att of item.attachments || []) {
        if (!att.inlineContent) {
          await deleteAttachmentBlob(att.id);
        }
      }
    }
  } catch (_) {
    // 무시
  }

  // 2) LocalStorage에서 해당 계정의 카테고리 및 작업물 키 삭제
  localStorage.removeItem(getUserCategoriesStorageKey(userId));
  localStorage.removeItem(getUserItemsStorageKey(userId));

  // 3) 사용자 목록에서 제거 후 세션 종료
  users.splice(userIdx, 1);
  saveUsers();

  closeAccountSettingsModal();
  setSessionAndSwitchWorkspace(null);
  alert(`'${userObj.name} (${userObj.id})' 계정과 전용 공간이 삭제되었습니다.`);
}

// ==================== 동적 UI 렌더링 (통계, 탭, 셀렉트박스) ====================
function renderHeroStats() {
  if (!viewingUser) {
    heroStats.innerHTML = '';
    return;
  }

  const totalCard = `
    <div class="stat-card">
      <div class="stat-card-top">
        <span class="stat-value">${items.length}</span>
        <span class="stat-cat-icon" style="background: var(--accent-soft); color: var(--accent-primary);">🗂️</span>
      </div>
      <span class="stat-label">공간 전체 항목</span>
    </div>
  `;

  const catCards = categories
    .map((cat) => {
      const count = items.filter((item) => item.category === cat.id).length;
      const { r, g, b } = hexToRgb(cat.color);
      return `
        <div class="stat-card" style="border-top: 3px solid ${escapeHtml(cat.color)}">
          <div class="stat-card-top">
            <span class="stat-value">${count}</span>
            <span class="stat-cat-icon" style="background: rgba(${r}, ${g}, ${b}, 0.12); color: ${escapeHtml(cat.color)};">
              ${renderCategoryIconHtml(cat, 'tab')}
            </span>
          </div>
          <span class="stat-label">${escapeHtml(cat.label)}</span>
        </div>
      `;
    })
    .join('');

  heroStats.innerHTML = totalCard + catCards;
}

function renderCategoryTabs() {
  if (activeCategory !== 'all' && !categories.some((c) => c.id === activeCategory)) {
    activeCategory = 'all';
  }

  const allTab = `
    <button type="button" class="tab-btn ${activeCategory === 'all' ? 'active' : ''}" data-category="all">
      <span>전체 보기</span>
    </button>
  `;

  const catTabs = categories
    .map((cat) => {
      const isActive = activeCategory === cat.id;
      return `
        <button
          type="button"
          class="tab-btn ${isActive ? 'active' : ''}"
          data-category="${escapeHtml(cat.id)}"
          style="${isActive ? `color: ${escapeHtml(cat.color)};` : ''}"
        >
          <span class="tab-color-dot" style="background:${escapeHtml(cat.color)}"></span>
          ${renderCategoryIconHtml(cat, 'tab')}
          <span>${escapeHtml(cat.label)}</span>
        </button>
      `;
    })
    .join('');

  categoryTabs.innerHTML = allTab + catTabs;
}

function renderCategorySelectOptions(selectedId) {
  if (categories.length === 0) {
    itemCategorySelect.innerHTML = `<option value="unclassified">미분류 (카테고리를 먼저 추가해 주세요)</option>`;
    return;
  }

  itemCategorySelect.innerHTML = categories
    .map(
      (cat) =>
        `<option value="${escapeHtml(cat.id)}" ${cat.id === selectedId ? 'selected' : ''}>${escapeHtml(cat.label)}</option>`
    )
    .join('');
}

// 필터링 및 정렬된 항목 반환
function getFilteredItems() {
  const query = searchQuery.trim().toLowerCase();

  const filtered = items.filter((item) => {
    const matchCategory = activeCategory === 'all' || item.category === activeCategory;
    if (!matchCategory) return false;

    if (!query) return true;

    const inTitle = item.title.toLowerCase().includes(query);
    const inSummary = item.summary.toLowerCase().includes(query);
    const inDesc = item.description.toLowerCase().includes(query);
    const inTags = (item.tags || []).some((t) => t.toLowerCase().includes(query));
    const inFiles = (item.attachments || []).some((f) => f.name.toLowerCase().includes(query));

    return inTitle || inSummary || inDesc || inTags || inFiles;
  });

  return filtered.sort((a, b) => {
    if (sortOrder === 'newest') return b.date.localeCompare(a.date);
    if (sortOrder === 'oldest') return a.date.localeCompare(b.date);
    if (sortOrder === 'title') return a.title.localeCompare(b.title, 'ko');
    return 0;
  });
}

// ==================== 갤러리 렌더링 ====================
function renderGallery() {
  renderAuthStatusBar();
  renderWorkspaceHeaderAndPermissions();

  if (!viewingUser) {
    portfolioGrid.innerHTML = '';
    return;
  }

  renderHeroStats();
  renderCategoryTabs();
  renderCategorySelectOptions(itemCategorySelect.value);

  const filtered = getFilteredItems();
  const modePrefix = isReadOnlySharedMode() ? `[읽기 전용] ${viewingUser.name}님의 공간` : `${viewingUser.name}님의 공간`;
  resultsCount.textContent = `${modePrefix} · 총 ${filtered.length}개의 항목`;

  if (filtered.length === 0) {
    portfolioGrid.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');

  portfolioGrid.innerHTML = filtered
    .map((item) => {
      const meta = getCategoryMeta(item.category);
      const tagsHtml = (item.tags || [])
        .slice(0, 4)
        .map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`)
        .join('');

      const attachments = item.attachments || [];
      const videoCount =
        attachments.filter((a) => a.kind === 'video').length + (item.videoUrl ? 1 : 0);
      const docCount = attachments.filter((a) => a.kind === 'document' || a.kind === 'image').length;

      const pills = [];
      if (videoCount > 0) pills.push(`<span class="attach-pill">🎬 영상 ${videoCount}</span>`);
      if (docCount > 0) pills.push(`<span class="attach-pill">📎 자료 ${docCount}</span>`);

      return `
        <article class="portfolio-card" data-id="${escapeHtml(item.id)}" tabindex="0" role="button" aria-label="${escapeHtml(item.title)} 상세 보기">
          <div class="card-cover" style="background: ${meta.gradient}">
            <div class="card-cover-top">
              <span class="card-icon" aria-hidden="true">${renderCategoryIconHtml(meta, 'card')}</span>
              <span class="card-date-chip">${escapeHtml(item.date)}</span>
            </div>
            <span class="card-cover-label">${escapeHtml(meta.coverLabel || meta.label)}</span>
          </div>
          <div class="card-body">
            <div class="card-meta">
              <span class="badge" style="${meta.badgeStyle}">${escapeHtml(meta.label)}</span>
              <div class="card-attachment-counts">${pills.join('')}</div>
            </div>
            <h3 class="card-title">${escapeHtml(item.title)}</h3>
            <p class="card-summary">${escapeHtml(item.summary)}</p>
            <div class="card-tags">${tagsHtml}</div>
            <div class="card-footer" style="color: ${escapeHtml(meta.color)}">
              <span>상세 내용 · 영상 · 문서 열람</span>
              <span class="card-arrow">&rarr;</span>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

// ==================== 카테고리 관리 모달 로직 ====================
function renderCategoryManageList() {
  if (categories.length === 0) {
    categoryManageList.innerHTML = `
      <li class="category-manage-item">
        <span style="color: var(--text-muted); font-size: 0.9rem;">내 공간에 등록된 카테고리가 없습니다. 아래에서 새 카테고리를 추가해 보세요.</span>
      </li>
    `;
    return;
  }

  categoryManageList.innerHTML = categories
    .map((cat) => {
      const itemCount = items.filter((i) => i.category === cat.id).length;
      const gradient = getGradientFromColor(cat.color);
      const badgeStyle = getBadgeStyleFromColor(cat.color);

      return `
        <li class="category-manage-item">
          <div class="category-manage-info">
            <div class="category-manage-icon" style="background: ${gradient}">
              ${renderCategoryIconHtml(cat, 'card')}
            </div>
            <div class="category-manage-text">
              <div class="category-manage-name">
                <span>${escapeHtml(cat.label)}</span>
                <span class="badge" style="${badgeStyle}">${escapeHtml(cat.color.toUpperCase())}</span>
              </div>
              <span class="category-manage-sub">${escapeHtml(cat.coverLabel || '')} · 내 작업물 ${itemCount}개</span>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:6px;">
            <button type="button" class="btn btn-secondary btn-sm edit-cat-btn" data-cat-id="${escapeHtml(cat.id)}">
              수정
            </button>
            <button type="button" class="btn btn-danger-ghost btn-sm delete-cat-btn" data-cat-id="${escapeHtml(cat.id)}">
              삭제
            </button>
          </div>
        </li>
      `;
    })
    .join('');
}

function updateCategoryPreviewCard() {
  const color = catColorInput.value || '#7c3aed';
  catColorHex.textContent = color.toUpperCase();
  catIconPreviewCard.style.background = getGradientFromColor(color);

  if (customCatIconDataUrl) {
    catIconPreviewDisplay.innerHTML = `<img src="${escapeHtml(customCatIconDataUrl)}" alt="커스텀 아이콘 미리보기" />`;
    clearCustomIconBtn.classList.remove('hidden');
  } else {
    const emoji = catEmojiInput.value.trim() || '📁';
    catIconPreviewDisplay.textContent = emoji;
    clearCustomIconBtn.classList.add('hidden');
  }
}

function resetCategoryForm() {
  editingCategoryId = null;
  addCategoryForm.reset();
  customCatIconDataUrl = null;
  catColorInput.value = '#7c3aed';
  catEmojiInput.value = '🎲';
  if (catFormTitle) catFormTitle.textContent = '+ 새 카테고리 항목 추가';
  if (catSubmitBtn) catSubmitBtn.textContent = '+ 카테고리 추가하기';
  if (cancelEditCatBtn) cancelEditCatBtn.classList.add('hidden');
  updateCategoryPreviewCard();
}

function startEditCategory(catId) {
  const targetCat = categories.find((c) => c.id === catId);
  if (!targetCat) return;

  editingCategoryId = targetCat.id;
  catNameInput.value = targetCat.label || '';
  catSubInput.value = targetCat.coverLabel || '';
  catColorInput.value = targetCat.color || '#7c3aed';

  if (targetCat.iconType === 'image' && targetCat.iconValue) {
    customCatIconDataUrl = targetCat.iconValue;
    catEmojiInput.value = '';
  } else {
    customCatIconDataUrl = null;
    catEmojiInput.value = targetCat.iconValue || '📁';
  }

  if (catFormTitle) catFormTitle.textContent = `✏️ '${targetCat.label}' 카테고리 수정`;
  if (catSubmitBtn) catSubmitBtn.textContent = '✓ 카테고리 수정 완료';
  if (cancelEditCatBtn) cancelEditCatBtn.classList.remove('hidden');

  updateCategoryPreviewCard();
  catNameInput.focus();
}

function openCategoryModal() {
  if (!isEditableWorkspace()) {
    alert('읽기 전용 공유 모드에서는 카테고리를 편집할 수 없습니다.');
    return;
  }
  resetCategoryForm();
  renderCategoryManageList();
  categoryModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeCategoryModal() {
  categoryModal.classList.add('hidden');
  resetCategoryForm();
  if (
    addModal.classList.contains('hidden') &&
    detailModal.classList.contains('hidden') &&
    authModal.classList.contains('hidden') &&
    accountSettingsModal.classList.contains('hidden') &&
    exploreUsersModal.classList.contains('hidden')
  ) {
    document.body.style.overflow = '';
  }
}

// ==================== 상세 모달 열기 & 첨부 렌더링 ====================
async function openDetailModal(itemId) {
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return;

  clearActiveObjectUrls();
  closeDocumentPreview();

  selectedItemId = item.id;
  const meta = getCategoryMeta(item.category);

  modalBanner.style.background = meta.gradient;
  modalCategoryBadge.className = 'badge';
  modalCategoryBadge.style.cssText = 'background: rgba(255,255,255,0.22); color: #ffffff;';
  modalCategoryBadge.textContent = meta.label;
  modalAuthor.textContent = `👤 ${viewingUser ? viewingUser.name : item.authorName || ''}`;
  modalDate.textContent = item.date;
  modalTitle.textContent = item.title;
  modalSubtitle.textContent = item.summary;
  modalDescription.textContent = item.description;

  // 읽기 전용 공유 모드일 경우 삭제 버튼 숨김 및 안내 표시
  if (isEditableWorkspace()) {
    deleteItemBtn.classList.remove('hidden');
    deletePermissionHint.classList.add('hidden');
  } else {
    deleteItemBtn.classList.add('hidden');
    deletePermissionHint.classList.remove('hidden');
    deletePermissionHint.textContent = '🔒 읽기 전용 공유 공간이므로 편집 및 삭제할 수 없습니다';
  }

  if (item.highlights && item.highlights.length > 0) {
    modalHighlightsSection.classList.remove('hidden');
    modalHighlights.innerHTML = item.highlights
      .map((point) => `<li>${escapeHtml(point)}</li>`)
      .join('');
  } else {
    modalHighlightsSection.classList.add('hidden');
  }

  modalTags.innerHTML = (item.tags || [])
    .map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`)
    .join('');

  if (item.links && item.links.length > 0) {
    const validLinks = item.links.filter((l) => sanitizeUrl(l.url));
    if (validLinks.length > 0) {
      modalLinksSection.classList.remove('hidden');
      modalLinks.innerHTML = validLinks
        .map(
          (link) => `
            <a href="${escapeHtml(sanitizeUrl(link.url))}" target="_blank" rel="noopener noreferrer nofollow" class="modal-link-item">
              <span>🔗 ${escapeHtml(link.label)}</span>
            </a>
          `
        )
        .join('');
    } else {
      modalLinksSection.classList.add('hidden');
    }
  } else {
    modalLinksSection.classList.add('hidden');
  }

  await renderModalAttachments(item);

  detailModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

async function renderModalAttachments(item) {
  const attachments = item.attachments || [];
  const mediaAttachments = attachments.filter((a) => a.kind === 'video' || a.kind === 'image');
  const docAttachments = attachments.filter((a) => a.kind !== 'video' && a.kind !== 'image');

  const mediaHtmlParts = [];

  if (item.videoUrl) {
    const parsedVideo = parseExternalVideoUrl(item.videoUrl);
    if (parsedVideo) {
      if (parsedVideo.mode === 'iframe') {
        mediaHtmlParts.push(`
          <div class="media-card">
            <div class="video-iframe-wrapper">
              <iframe src="${escapeHtml(parsedVideo.src)}" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>
            </div>
            <div class="media-card-caption">
              <span>🎬 외부 연결 영상</span>
              <a href="${escapeHtml(item.videoUrl)}" target="_blank" rel="noopener noreferrer" class="text-btn">원본 링크 열기</a>
            </div>
          </div>
        `);
      } else {
        mediaHtmlParts.push(`
          <div class="media-card">
            <video class="video-player" controls preload="metadata" src="${escapeHtml(parsedVideo.src)}"></video>
            <div class="media-card-caption">
              <span>🎬 외부 연결 영상</span>
              <a href="${escapeHtml(item.videoUrl)}" target="_blank" rel="noopener noreferrer" class="text-btn">원본 링크 열기</a>
            </div>
          </div>
        `);
      }
    }
  }

  for (const media of mediaAttachments) {
    const blob = await resolveAttachmentBlob(media);
    if (!blob) continue;

    const objUrl = URL.createObjectURL(blob);
    activeObjectUrls.push(objUrl);

    if (media.kind === 'video') {
      mediaHtmlParts.push(`
        <div class="media-card">
          <video class="video-player" controls preload="metadata" src="${objUrl}"></video>
          <div class="media-card-caption">
            <span>🎬 ${escapeHtml(media.name)} (${formatFileSize(media.size)})</span>
            <a href="${objUrl}" download="${escapeHtml(media.name)}" class="text-btn">영상 다운로드</a>
          </div>
        </div>
      `);
    } else if (media.kind === 'image') {
      mediaHtmlParts.push(`
        <div class="media-card">
          <img class="image-attachment-preview" src="${objUrl}" alt="${escapeHtml(media.name)}" />
          <div class="media-card-caption">
            <span>🖼️ ${escapeHtml(media.name)} (${formatFileSize(media.size)})</span>
            <a href="${objUrl}" download="${escapeHtml(media.name)}" class="text-btn">이미지 다운로드</a>
          </div>
        </div>
      `);
    }
  }

  if (mediaHtmlParts.length > 0) {
    modalMediaSection.classList.remove('hidden');
    modalMediaList.innerHTML = mediaHtmlParts.join('');
  } else {
    modalMediaSection.classList.add('hidden');
    modalMediaList.innerHTML = '';
  }

  if (docAttachments.length > 0) {
    modalFilesSection.classList.remove('hidden');
    const docCards = [];

    for (const doc of docAttachments) {
      const blob = await resolveAttachmentBlob(doc);
      if (!blob) continue;

      const objUrl = URL.createObjectURL(blob);
      activeObjectUrls.push(objUrl);

      const canPreview = isPreviewableDocument(doc);
      const previewBtnHtml = canPreview
        ? `<button type="button" class="btn btn-secondary btn-sm preview-doc-btn" data-att-id="${escapeHtml(doc.id)}">미리보기</button>`
        : '';

      docCards.push(`
        <div class="file-attachment-card">
          <div class="file-info">
            <span class="file-type-icon" aria-hidden="true">${getFileIcon(doc)}</span>
            <div class="file-details">
              <div class="file-name">${escapeHtml(doc.name)}</div>
              <div class="file-size">${formatFileSize(doc.size)}</div>
            </div>
          </div>
          <div class="file-actions">
            ${previewBtnHtml}
            <a href="${objUrl}" download="${escapeHtml(doc.name)}" class="btn btn-primary btn-sm">다운로드</a>
          </div>
        </div>
      `);
    }

    modalFilesList.innerHTML = docCards.join('');
  } else {
    modalFilesSection.classList.add('hidden');
    modalFilesList.innerHTML = '';
  }
}

async function resolveAttachmentBlob(attMeta) {
  if (attMeta.inlineContent) {
    return new Blob([attMeta.inlineContent], { type: attMeta.type || 'text/plain;charset=utf-8' });
  }
  return await getAttachmentBlob(attMeta.id);
}

async function openDocumentPreview(attId) {
  const item = items.find((i) => i.id === selectedItemId);
  if (!item || !item.attachments) return;

  const att = item.attachments.find((a) => a.id === attId);
  if (!att) return;

  const blob = await resolveAttachmentBlob(att);
  if (!blob) return;

  docPreviewTitle.textContent = `📄 ${att.name}`;
  const lowerName = (att.name || '').toLowerCase();

  if (att.type === 'application/pdf' || lowerName.endsWith('.pdf')) {
    const pdfUrl = URL.createObjectURL(blob);
    activeObjectUrls.push(pdfUrl);
    docPreviewBody.innerHTML = `<iframe class="doc-preview-iframe" src="${pdfUrl}"></iframe>`;
  } else {
    const text = await blob.text();
    docPreviewBody.textContent = text;
  }

  modalDocPreview.classList.remove('hidden');
}

function closeDocumentPreview() {
  modalDocPreview.classList.add('hidden');
  docPreviewBody.innerHTML = '';
}

function closeDetailModal() {
  modalMediaList.querySelectorAll('video').forEach((v) => v.pause());
  modalMediaList.innerHTML = '';
  closeDocumentPreview();
  clearActiveObjectUrls();

  detailModal.classList.add('hidden');
  document.body.style.overflow = '';
  selectedItemId = null;
}

// ==================== 새 항목 등록 모달 & 파일 선택 ====================
function renderPendingFilesList() {
  if (pendingFiles.length === 0) {
    selectedFilesList.innerHTML = '';
    return;
  }

  selectedFilesList.innerHTML = pendingFiles
    .map((file, idx) => {
      const kind = classifyFileKind(file);
      const badge = kind === 'video' ? '🎬 영상' : kind === 'image' ? '🖼️ 이미지' : '📄 문서';
      return `
        <li class="selected-file-item">
          <div class="selected-file-name">
            <strong>[${badge}]</strong> ${escapeHtml(file.name)}
            <span class="selected-file-meta">(${formatFileSize(file.size)})</span>
          </div>
          <button type="button" class="remove-file-btn" data-index="${idx}">제거</button>
        </li>
      `;
    })
    .join('');
}

// 위험 파일 확장자 차단 (XSS 및 실행 파일 방지)
const BLOCKED_FILE_EXTENSIONS = [
  'exe', 'bat', 'cmd', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'scr', 'pif', 'com',
  'html', 'htm', 'xhtml', 'shtml', 'svg', 'php', 'asp', 'aspx', 'jsp', 'cgi', 'sh', 'bash'
];

function isSafeFile(file) {
  if (!file || !file.name) return false;
  const parts = file.name.split('.');
  if (parts.length < 2) return true;
  const ext = parts.pop().toLowerCase();
  return !BLOCKED_FILE_EXTENSIONS.includes(ext);
}

function addFilesToPending(fileList) {
  const incoming = Array.from(fileList || []);
  if (incoming.length === 0) return;

  const blocked = [];
  const safe = [];

  for (const f of incoming) {
    if (isSafeFile(f)) {
      safe.push(f);
    } else {
      blocked.push(f.name);
    }
  }

  if (blocked.length > 0) {
    alert(`보안상 실행 가능 파일 및 웹 스크립트 파일은 첨부할 수 없습니다:\n- ${blocked.join('\n- ')}`);
  }

  if (safe.length > 0) {
    pendingFiles.push(...safe);
    renderPendingFilesList();
  }
}

function openAddModal() {
  if (!isEditableWorkspace()) {
    alert('읽기 전용 공유 모드에서는 새 작업물을 등록할 수 없습니다.');
    return;
  }
  addItemForm.reset();
  pendingFiles = [];
  renderPendingFilesList();
  renderCategorySelectOptions(categories[0] ? categories[0].id : '');

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  document.getElementById('item-date').value = `${yyyy}.${mm}`;

  addModal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeAddModal() {
  addModal.classList.add('hidden');
  document.body.style.overflow = '';
  pendingFiles = [];
  renderPendingFilesList();
}

// ==================== 이벤트 리스너 등록 ====================
function initEvents() {
  // 상단 '작업물 & 자료실' 클릭 시 읽기 전용 공유 열람 중이면 내 공간으로 복귀
  if (navWorkspaceLink) {
    navWorkspaceLink.addEventListener('click', () => {
      if (isReadOnlySharedMode() && currentUser) {
        exitReadOnlySharedSpace();
      }
    });
  }

  // 상단 '🔍 타인 공간 검색' 버튼 및 잠금 화면 내 검색 버튼
  if (openExploreModalBtn) {
    openExploreModalBtn.addEventListener('click', openExploreUsersModal);
  }
  if (lockedExploreBtn) {
    lockedExploreBtn.addEventListener('click', openExploreUsersModal);
  }

  // 타인 공간 검색 모달 이벤트
  closeExploreUsersModalBtn.addEventListener('click', closeExploreUsersModal);
  closeExploreFooterBtn.addEventListener('click', closeExploreUsersModal);
  exploreUsersModal.addEventListener('click', (e) => {
    if (e.target === exploreUsersModal) {
      closeExploreUsersModal();
      return;
    }
    const openSpaceBtn = e.target.closest('.explore-open-space-btn');
    if (openSpaceBtn) {
      const targetUserId = openSpaceBtn.dataset.shareUserId;
      closeExploreUsersModal();
      enterReadOnlySharedSpace(targetUserId);
    }
  });

  exploreUserSearchInput.addEventListener('input', (e) => {
    renderExploreUsersList(e.target.value);
  });

  // 상단 인증 상태바 이벤트 (로그인 / 공유 설정 / 계정 설정 / 로그아웃)
  authStatusBar.addEventListener('click', (e) => {
    if (e.target.closest('#open-auth-modal-btn')) {
      openAuthModal();
      return;
    }
    if (e.target.closest('#open-share-modal-btn')) {
      openShareSettingsModal();
      return;
    }
    if (e.target.closest('#open-account-settings-btn')) {
      openAccountSettingsModal();
      return;
    }
    if (e.target.closest('#logout-btn')) {
      setSessionAndSwitchWorkspace(null);
    }
  });

  if (lockedLoginBtn) {
    lockedLoginBtn.addEventListener('click', () => openAuthModal());
  }

  if (exitSharedViewBtn) {
    exitSharedViewBtn.addEventListener('click', exitReadOnlySharedSpace);
  }

  // 로그인 모달 탭 전환 및 배경 클릭 닫기
  authModal.addEventListener('click', (e) => {
    if (e.target === authModal) {
      closeAuthModal();
      return;
    }
    const tabBtn = e.target.closest('.auth-tab-btn');
    if (tabBtn) {
      switchAuthTab(tabBtn.dataset.tab);
    }
  });

  closeAuthModalBtn.addEventListener('click', closeAuthModal);

  // 공유 설정 전용 모달 이벤트
  if (closeShareSettingsModalBtn) closeShareSettingsModalBtn.addEventListener('click', closeShareSettingsModal);
  if (closeShareFooterBtn) closeShareFooterBtn.addEventListener('click', closeShareSettingsModal);
  if (shareSettingsModal) {
    shareSettingsModal.addEventListener('click', (e) => {
      if (e.target === shareSettingsModal) closeShareSettingsModal();
    });
  }

  // 계정 설정 전용 모달 이벤트
  closeAccountSettingsModalBtn.addEventListener('click', closeAccountSettingsModal);
  if (closeAccountFooterBtn) closeAccountFooterBtn.addEventListener('click', closeAccountSettingsModal);
  accountSettingsModal.addEventListener('click', (e) => {
    if (e.target === accountSettingsModal) closeAccountSettingsModal();
  });

  shareAllowCheckbox.addEventListener('change', () => {
    if (!currentUser) return;
    const userObj = users.find((u) => u.id.toLowerCase() === currentUser.id.toLowerCase());
    if (!userObj) return;

    userObj.shareEnabled = shareAllowCheckbox.checked;
    saveUsers();
    shareLinkArea.classList.toggle('hidden', !userObj.shareEnabled);
    copyShareFeedback.textContent = userObj.shareEnabled
      ? '공유가 활성화되었습니다.'
      : '공유가 비활성화되었습니다.';
  });

  copyShareUrlBtn.addEventListener('click', async () => {
    const url = shareUrlInput.value;
    try {
      await navigator.clipboard.writeText(url);
      copyShareFeedback.textContent = '✓ 읽기 전용 공유 링크가 복사되었습니다!';
    } catch (_) {
      shareUrlInput.select();
      document.execCommand('copy');
      copyShareFeedback.textContent = '✓ 읽기 전용 공유 링크가 복사되었습니다!';
    }
  });

  previewReadonlyBtn.addEventListener('click', () => {
    if (!currentUser) return;
    closeAccountSettingsModal();
    enterReadOnlySharedSpace(currentUser.id);
  });

  deleteAccountForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = deleteAccountPwInput.value;
    await deleteCurrentAccountPermanently(pw);
  });

  // 프로필 표시 이름 (닉네임) 변경
  if (profileNameForm) {
    profileNameForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!currentUser) return;
      const userObj = users.find((u) => u.id.toLowerCase() === currentUser.id.toLowerCase());
      if (!userObj) return;

      const newName = editProfileNameInput.value.trim();
      if (newName.length < 1) {
        if (profileNameFeedback) {
          profileNameFeedback.style.color = '#dc2626';
          profileNameFeedback.textContent = '이름을 최소 1글자 이상 입력해 주세요.';
        }
        return;
      }

      userObj.name = newName;
      currentUser.name = newName;
      if (viewingUser && viewingUser.id.toLowerCase() === currentUser.id.toLowerCase()) {
        viewingUser.name = newName;
      }
      saveUsers();

      if (profileNameFeedback) {
        profileNameFeedback.style.color = '#059669';
        profileNameFeedback.textContent = '✓ 표시 이름이 성공적으로 변경되었습니다!';
      }
      renderAuthStatusBar();
      renderWorkspaceHeaderAndPermissions();
    });
  }

  // 내 공간 헤더 인삿말 커스텀 저장
  if (heroCustomForm) {
    heroCustomForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!currentUser) return;
      const userObj = users.find((u) => u.id.toLowerCase() === currentUser.id.toLowerCase());
      if (!userObj) return;

      userObj.customHeroTitle = customHeroTitleInput.value.trim();
      userObj.customHeroDesc = customHeroDescInput.value.trim();
      saveUsers();

      if (heroCustomFeedback) {
        heroCustomFeedback.style.color = '#059669';
        heroCustomFeedback.textContent = '✓ 내 공간 제목과 인삿말이 저장되었습니다!';
      }
      renderWorkspaceHeaderAndPermissions();
    });
  }

  // 인삿말 기본 문구로 초기화
  if (resetHeroCustomBtn) {
    resetHeroCustomBtn.addEventListener('click', () => {
      if (!currentUser) return;
      const userObj = users.find((u) => u.id.toLowerCase() === currentUser.id.toLowerCase());
      if (!userObj) return;

      userObj.customHeroTitle = '';
      userObj.customHeroDesc = '';
      saveUsers();

      if (customHeroTitleInput) customHeroTitleInput.value = '';
      if (customHeroDescInput) customHeroDescInput.value = '';
      if (heroCustomFeedback) {
        heroCustomFeedback.style.color = '#2563eb';
        heroCustomFeedback.textContent = '기본 인삿말로 복원되었습니다.';
      }
      renderWorkspaceHeaderAndPermissions();
    });
  }

  // 현재 계정 비밀번호 변경
  if (changePasswordForm) {
    changePasswordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!currentUser) return;

      const userObj = users.find((u) => u.id.toLowerCase() === currentUser.id.toLowerCase());
      if (!userObj) return;

      const currentPw = currentPwInput.value;
      const newPw = newPwInput.value;
      const newPwConfirm = newPwConfirmInput.value;

      if (changePwAlert) changePwAlert.classList.add('hidden');
      if (changePwFeedback) changePwFeedback.textContent = '';

      const isCurrentMatch = await verifyPassword(userObj, currentPw);
      if (!isCurrentMatch) {
        if (changePwAlert) {
          changePwAlert.textContent = '현재 비밀번호가 일치하지 않습니다.';
          changePwAlert.classList.remove('hidden');
        }
        return;
      }

      if (newPw.length < 4) {
        if (changePwAlert) {
          changePwAlert.textContent = '새 비밀번호는 4자리 이상이어야 합니다.';
          changePwAlert.classList.remove('hidden');
        }
        return;
      }

      if (newPw !== newPwConfirm) {
        if (changePwAlert) {
          changePwAlert.textContent = '새 비밀번호와 비밀번호 확인이 일치하지 않습니다.';
          changePwAlert.classList.remove('hidden');
        }
        return;
      }

      userObj.passwordHash = await hashPassword(newPw);
      saveUsers();

      changePasswordForm.reset();
      if (changePwFeedback) {
        changePwFeedback.style.color = '#059669';
        changePwFeedback.textContent = '✓ 비밀번호가 안전하게 변경되었습니다!';
      }
    });
  }

  // 지인 초대 코드 저장 이벤트 (관리자 전용)
  if (saveInviteCodeBtn && manageInviteCodeInput) {
    saveInviteCodeBtn.addEventListener('click', () => {
      const val = manageInviteCodeInput.value.trim();
      if (val.length < 3) {
        if (manageInviteFeedback) {
          manageInviteFeedback.style.color = '#dc2626';
          manageInviteFeedback.textContent = '초대 코드는 최소 3자 이상이어야 합니다.';
        }
        return;
      }
      setStoredInviteCode(val);
      if (manageInviteFeedback) {
        manageInviteFeedback.style.color = '#059669';
        manageInviteFeedback.textContent = '✓ 새 지인 초대 코드가 저장되었습니다!';
      }
    });
  }

  // 로그인 연속 실패 제한 (Brute-Force 방어)
  let loginFailCount = 0;
  let lockUntilTimestamp = 0;

  // 로그인 폼 제출 -> 해당 계정의 고유 워크스페이스로 전환
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const now = Date.now();
    if (lockUntilTimestamp > now) {
      const remainSec = Math.ceil((lockUntilTimestamp - now) / 1000);
      showAuthAlert(`보안을 위해 로그인이 일시 차단되었습니다. ${remainSec}초 후 다시 시도하세요.`);
      return;
    }

    const id = loginIdInput.value.trim();
    const pw = loginPwInput.value;

    const user = users.find((u) => u.id.toLowerCase() === id.toLowerCase());
    const isMatch = await verifyPassword(user, pw);

    if (!user || !isMatch) {
      loginFailCount++;
      if (loginFailCount >= 5) {
        lockUntilTimestamp = Date.now() + 60 * 1000; // 60초 잠금
        loginFailCount = 0;
        showAuthAlert('연속 5회 로그인에 실패하여 보안을 위해 1분간 로그인이 제한됩니다.');
      } else {
        showAuthAlert(`아이디 또는 비밀번호가 일치하지 않습니다. (실패 ${loginFailCount}/5회)`);
      }
      return;
    }

    loginFailCount = 0;
    lockUntilTimestamp = 0;
    const cb = pendingAuthCallback;
    closeAuthModal();
    setSessionAndSwitchWorkspace(user);
    if (typeof cb === 'function') cb();
  });

  // 회원가입(새 사용자 등록) -> 초대 코드 확인 후 새 계정의 독립된 고유 공간 생성 및 전환
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const inputInvite = inviteCodeInput ? inviteCodeInput.value.trim() : '';
    const storedInvite = getStoredInviteCode();

    if (!inputInvite || inputInvite !== storedInvite) {
      showAuthAlert('가입 초대 코드가 일치하지 않습니다. 관리자에게 승인된 지인 초대 코드를 확인해 주세요.');
      return;
    }

    const id = signupIdInput.value.trim();
    const name = signupNameInput.value.trim();
    const pw = signupPwInput.value;
    const pwConfirm = signupPwConfirmInput.value;

    if (id.length < 2) {
      showAuthAlert('아이디는 2글자 이상 입력해 주세요.');
      return;
    }
    if (users.some((u) => u.id.toLowerCase() === id.toLowerCase())) {
      showAuthAlert('이미 사용 중인 아이디입니다. 다른 아이디를 입력해 주세요.');
      return;
    }
    if (pw.length < 4) {
      showAuthAlert('보안을 위해 비밀번호는 4자리 이상 입력해 주세요.');
      return;
    }
    if (pw !== pwConfirm) {
      showAuthAlert('비밀번호와 비밀번호 확인이 일치하지 않습니다.');
      return;
    }

    const hashedPw = await hashPassword(pw);
    const newUser = {
      id,
      name,
      passwordHash: hashedPw,
      shareEnabled: true
    };

    users.push(newUser);
    saveUsers();

    localStorage.setItem(
      getUserCategoriesStorageKey(newUser.id),
      JSON.stringify(DEFAULT_EXAMPLE_CATEGORIES)
    );
    localStorage.setItem(getUserItemsStorageKey(newUser.id), JSON.stringify([]));

    const cb = pendingAuthCallback;
    closeAuthModal();
    setSessionAndSwitchWorkspace(newUser);
    if (typeof cb === 'function') cb();
  });

  // 카테고리 탭 전환
  categoryTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;

    activeCategory = btn.dataset.category;
    renderGallery();
  });

  // 검색 입력
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderGallery();
  });

  // 정렬 선택
  sortSelect.addEventListener('change', (e) => {
    sortOrder = e.target.value;
    renderGallery();
  });

  // 필터 초기화
  resetFilterBtn.addEventListener('click', () => {
    activeCategory = 'all';
    searchQuery = '';
    searchInput.value = '';
    renderGallery();
  });

  // 카드 클릭 -> 상세 모달 오픈
  portfolioGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.portfolio-card');
    if (!card) return;
    openDetailModal(card.dataset.id);
  });

  portfolioGrid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const card = e.target.closest('.portfolio-card');
      if (!card) return;
      e.preventDefault();
      openDetailModal(card.dataset.id);
    }
  });

  // 상세 모달 내 문서 미리보기 버튼 클릭
  modalFilesList.addEventListener('click', (e) => {
    const previewBtn = e.target.closest('.preview-doc-btn');
    if (!previewBtn) return;
    openDocumentPreview(previewBtn.dataset.attId);
  });

  closeDocPreviewBtn.addEventListener('click', closeDocumentPreview);

  // 상세 모달 닫기
  closeDetailModalBtn.addEventListener('click', closeDetailModal);
  closeDetailFooterBtn.addEventListener('click', closeDetailModal);
  detailModal.addEventListener('click', (e) => {
    if (e.target === detailModal) closeDetailModal();
  });

  // 항목 삭제 (편집 권한이 있는 본인 공간에서만 허용)
  deleteItemBtn.addEventListener('click', async () => {
    if (!selectedItemId || !isEditableWorkspace()) {
      alert('읽기 전용 공유 상태에서는 항목을 삭제할 수 없습니다.');
      return;
    }
    const target = items.find((i) => i.id === selectedItemId);
    if (!target) return;

    if (confirm(`'${target.title}' 항목과 첨부된 파일을 모두 삭제하시겠습니까?`)) {
      for (const att of target.attachments || []) {
        if (!att.inlineContent) {
          await deleteAttachmentBlob(att.id);
        }
      }
      items = items.filter((i) => i.id !== selectedItemId);
      saveItems();
      closeDetailModal();
      renderGallery();
    }
  });

  // 파일 드롭존 클릭 & 드래그 앤 드롭
  fileDropZone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    addFilesToPending(e.target.files);
    fileInput.value = '';
  });

  fileDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    fileDropZone.classList.add('dragover');
  });

  fileDropZone.addEventListener('dragleave', () => {
    fileDropZone.classList.remove('dragover');
  });

  fileDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    fileDropZone.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files) {
      addFilesToPending(e.dataTransfer.files);
    }
  });

  selectedFilesList.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.remove-file-btn');
    if (!removeBtn) return;
    const index = Number(removeBtn.dataset.index);
    if (!Number.isNaN(index)) {
      pendingFiles.splice(index, 1);
      renderPendingFilesList();
    }
  });

  // 새 항목 등록 모달 열기/닫기
  openAddModalBtn.addEventListener('click', openAddModal);
  closeAddModalBtn.addEventListener('click', closeAddModal);
  cancelAddBtn.addEventListener('click', closeAddModal);
  addModal.addEventListener('click', (e) => {
    if (e.target === addModal) closeAddModal();
  });

  // ==================== 카테고리 관리 모달 이벤트 ====================
  openCategoryModalBtn.addEventListener('click', openCategoryModal);
  openCatFromAddBtn.addEventListener('click', openCategoryModal);
  closeCategoryModalBtn.addEventListener('click', closeCategoryModal);
  closeCategoryFooterBtn.addEventListener('click', closeCategoryModal);
  categoryModal.addEventListener('click', (e) => {
    if (e.target === categoryModal) closeCategoryModal();
  });

  catColorInput.addEventListener('input', updateCategoryPreviewCard);
  colorSwatchList.addEventListener('click', (e) => {
    const swatch = e.target.closest('.color-swatch');
    if (!swatch) return;
    catColorInput.value = swatch.dataset.color;
    updateCategoryPreviewCard();
  });

  catEmojiInput.addEventListener('input', () => {
    customCatIconDataUrl = null;
    updateCategoryPreviewCard();
  });

  emojiPresetList.addEventListener('click', (e) => {
    const btn = e.target.closest('.emoji-preset-btn');
    if (!btn) return;
    catEmojiInput.value = btn.dataset.emoji;
    customCatIconDataUrl = null;
    updateCategoryPreviewCard();
  });

  catIconFile.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      customCatIconDataUrl = reader.result;
      updateCategoryPreviewCard();
    };
    reader.readAsDataURL(file);
    catIconFile.value = '';
  });

  clearCustomIconBtn.addEventListener('click', () => {
    customCatIconDataUrl = null;
    updateCategoryPreviewCard();
  });

  // 카테고리 수정 취소 버튼
  if (cancelEditCatBtn) {
    cancelEditCatBtn.addEventListener('click', resetCategoryForm);
  }

  // 새 카테고리 추가 및 기존 카테고리 수정 제출
  addCategoryForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!isEditableWorkspace()) return;

    const label = catNameInput.value.trim();
    if (!label) return;

    const coverLabel = catSubInput.value.trim() || `${label} Archive`;
    const color = catColorInput.value || '#7c3aed';
    const iconType = customCatIconDataUrl ? 'image' : 'emoji';
    const iconValue = customCatIconDataUrl || catEmojiInput.value.trim() || '📁';

    if (editingCategoryId) {
      // 기존 카테고리 수정
      const catIdx = categories.findIndex((c) => c.id === editingCategoryId);
      if (catIdx !== -1) {
        categories[catIdx] = {
          ...categories[catIdx],
          label,
          coverLabel,
          color,
          iconType,
          iconValue
        };
      }
      const targetId = editingCategoryId;
      saveCategories();
      resetCategoryForm();
      renderCategoryManageList();
      renderGallery();
      renderCategorySelectOptions(targetId);
    } else {
      // 새 카테고리 추가
      const newCat = {
        id: `cat-${Date.now()}`,
        label,
        coverLabel,
        color,
        iconType,
        iconValue
      };

      categories.push(newCat);
      saveCategories();
      resetCategoryForm();
      renderCategoryManageList();
      renderGallery();
      renderCategorySelectOptions(newCat.id);
    }
  });

  // 카테고리 목록 내 수정 / 삭제 클릭 이벤트
  categoryManageList.addEventListener('click', (e) => {
    if (!isEditableWorkspace()) return;

    // 수정 버튼 클릭
    const editBtn = e.target.closest('.edit-cat-btn');
    if (editBtn) {
      const catId = editBtn.dataset.catId;
      startEditCategory(catId);
      return;
    }

    // 삭제 버튼 클릭
    const delBtn = e.target.closest('.delete-cat-btn');
    if (!delBtn) return;

    const catId = delBtn.dataset.catId;
    const targetCat = categories.find((c) => c.id === catId);
    if (!targetCat) return;

    const linkedCount = items.filter((i) => i.category === catId).length;
    const msg =
      linkedCount > 0
        ? `'${targetCat.label}' 카테고리를 내 공간에서 삭제하시겠습니까?\n(이 카테고리에 속한 작업물 ${linkedCount}개는 삭제되지 않고 '미분류 / 기타'로 유지됩니다.)`
        : `'${targetCat.label}' 카테고리를 내 공간에서 삭제하시겠습니까?`;

    if (confirm(msg)) {
      if (editingCategoryId === catId) {
        resetCategoryForm();
      }
      categories = categories.filter((c) => c.id !== catId);
      saveCategories();
      renderCategoryManageList();
      renderGallery();
    }
  });

  // 새 작업물/자료 폼 제출 (편집 가능한 본인 공간에서만 허용)
  addItemForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isEditableWorkspace()) {
      alert('읽기 전용 공유 모드에서는 작업물을 등록할 수 없습니다.');
      return;
    }

    const submitBtn = document.getElementById('submit-add-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = '저장 중...';

    try {
      const category = itemCategorySelect.value;
      const date = document.getElementById('item-date').value.trim();
      const title = document.getElementById('item-title').value.trim();
      const summary = document.getElementById('item-summary').value.trim();
      const description = document.getElementById('item-description').value.trim();
      const highlightsRaw = document.getElementById('item-highlights').value.trim();
      const videoUrl = document.getElementById('item-video-url').value.trim();
      const tagsRaw = document.getElementById('item-tags').value.trim();
      const linkLabel = document.getElementById('item-link-label').value.trim();
      const linkUrl = document.getElementById('item-link-url').value.trim();

      const highlights = highlightsRaw
        ? highlightsRaw.split('\n').map((s) => s.trim()).filter(Boolean)
        : [];

      const tags = tagsRaw
        ? tagsRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : ['아카이브'];

      const links = linkUrl
        ? [{ label: linkLabel || '관련 링크 열기', url: linkUrl }]
        : [];

      const savedAttachments = [];
      for (let i = 0; i < pendingFiles.length; i++) {
        const file = pendingFiles[i];
        const attId = `att-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`;
        await saveAttachmentBlob(attId, file);
        savedAttachments.push({
          id: attId,
          name: file.name,
          type: file.type || 'application/octet-stream',
          size: file.size,
          kind: classifyFileKind(file)
        });
      }

      const newItem = {
        id: `item-${Date.now()}`,
        category,
        date,
        authorId: currentUser.id,
        authorName: currentUser.name,
        title,
        summary,
        description,
        highlights,
        videoUrl,
        attachments: savedAttachments,
        tags,
        links
      };

      items.unshift(newItem);
      saveItems();
      closeAddModal();
      renderGallery();
    } catch (err) {
      alert('파일 저장 중 오류가 발생했습니다: ' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '등록하기';
    }
  });

  // 현재 열람 중인 공간 데이터 JSON 백업 다운로드
  exportJsonBtn.addEventListener('click', () => {
    if (!viewingUser) return;
    const backupPayload = {
      exportedAt: new Date().toISOString(),
      account: viewingUser,
      categories,
      items
    };
    const dataStr = JSON.stringify(backupPayload, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `portfolio-${viewingUser.id}-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ESC 키로 모달 닫기
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!exploreUsersModal.classList.contains('hidden')) {
        closeExploreUsersModal();
        return;
      }
      if (!shareSettingsModal.classList.contains('hidden')) {
        closeShareSettingsModal();
        return;
      }
      if (!accountSettingsModal.classList.contains('hidden')) {
        closeAccountSettingsModal();
        return;
      }
      if (!authModal.classList.contains('hidden')) {
        closeAuthModal();
        return;
      }
      if (!categoryModal.classList.contains('hidden')) {
        closeCategoryModal();
        return;
      }
      if (!detailModal.classList.contains('hidden')) closeDetailModal();
      if (!addModal.classList.contains('hidden')) closeAddModal();
    }
  });
}

// 초기화 실행
document.addEventListener('DOMContentLoaded', () => {
  loadUsersAndSession();
  loadViewingWorkspaceData();
  initEvents();
  renderGallery();
});

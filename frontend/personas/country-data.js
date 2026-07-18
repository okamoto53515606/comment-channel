// ===== 国・地域データ =====
const COUNTRY_REGIONS = {
  east_asia: [
    { code: 'JP', name: '日本', nameEn: 'Japan', flag: '🇯🇵' },
    { code: 'KR', name: '韓国', nameEn: 'South Korea', flag: '🇰🇷' },
    { code: 'CN', name: '中国', nameEn: 'China', flag: '🇨🇳' },
    { code: 'TW', name: '台湾', nameEn: 'Taiwan', flag: '🇹🇼' },
  ],
  southeast_asia: [
    { code: 'ID', name: 'インドネシア', nameEn: 'Indonesia', flag: '🇮🇩' },
    { code: 'TH', name: 'タイ', nameEn: 'Thailand', flag: '🇹🇭' },
    { code: 'VN', name: 'ベトナム', nameEn: 'Vietnam', flag: '🇻🇳' },
    { code: 'PH', name: 'フィリピン', nameEn: 'Philippines', flag: '🇵🇭' },
    { code: 'SG', name: 'シンガポール', nameEn: 'Singapore', flag: '🇸🇬' },
    { code: 'MY', name: 'マレーシア', nameEn: 'Malaysia', flag: '🇲🇾' },
  ],
  south_asia: [
    { code: 'IN', name: 'インド', nameEn: 'India', flag: '🇮🇳' },
    { code: 'PK', name: 'パキスタン', nameEn: 'Pakistan', flag: '🇵🇰' },
    { code: 'BD', name: 'バングラデシュ', nameEn: 'Bangladesh', flag: '🇧🇩' },
    { code: 'LK', name: 'スリランカ', nameEn: 'Sri Lanka', flag: '🇱🇰' },
  ],
  middle_east: [
    { code: 'SA', name: 'サウジアラビア', nameEn: 'Saudi Arabia', flag: '🇸🇦' },
    { code: 'AE', name: 'UAE', nameEn: 'UAE', flag: '🇦🇪' },
    { code: 'IR', name: 'イラン', nameEn: 'Iran', flag: '🇮🇷' },
    { code: 'TR', name: 'トルコ', nameEn: 'Turkey', flag: '🇹🇷' },
    { code: 'IL', name: 'イスラエル', nameEn: 'Israel', flag: '🇮🇱' },
  ],
  europe: [
    { code: 'GB', name: 'イギリス', nameEn: 'United Kingdom', flag: '🇬🇧' },
    { code: 'FR', name: 'フランス', nameEn: 'France', flag: '🇫🇷' },
    { code: 'DE', name: 'ドイツ', nameEn: 'Germany', flag: '🇩🇪' },
    { code: 'IT', name: 'イタリア', nameEn: 'Italy', flag: '🇮🇹' },
    { code: 'ES', name: 'スペイン', nameEn: 'Spain', flag: '🇪🇸' },
    { code: 'NL', name: 'オランダ', nameEn: 'Netherlands', flag: '🇳🇱' },
    { code: 'SE', name: 'スウェーデン', nameEn: 'Sweden', flag: '🇸🇪' },
    { code: 'PL', name: 'ポーランド', nameEn: 'Poland', flag: '🇵🇱' },
    { code: 'UA', name: 'ウクライナ', nameEn: 'Ukraine', flag: '🇺🇦' },
  ],
  north_america: [
    { code: 'US', name: 'アメリカ', nameEn: 'United States', flag: '🇺🇸' },
    { code: 'CA', name: 'カナダ', nameEn: 'Canada', flag: '🇨🇦' },
    { code: 'MX', name: 'メキシコ', nameEn: 'Mexico', flag: '🇲🇽' },
  ],
  south_america: [
    { code: 'BR', name: 'ブラジル', nameEn: 'Brazil', flag: '🇧🇷' },
    { code: 'AR', name: 'アルゼンチン', nameEn: 'Argentina', flag: '🇦🇷' },
    { code: 'CO', name: 'コロンビア', nameEn: 'Colombia', flag: '🇨🇴' },
    { code: 'CL', name: 'チリ', nameEn: 'Chile', flag: '🇨🇱' },
  ],
  africa: [
    { code: 'NG', name: 'ナイジェリア', nameEn: 'Nigeria', flag: '🇳🇬' },
    { code: 'ZA', name: '南アフリカ', nameEn: 'South Africa', flag: '🇿🇦' },
    { code: 'KE', name: 'ケニア', nameEn: 'Kenya', flag: '🇰🇪' },
    { code: 'EG', name: 'エジプト', nameEn: 'Egypt', flag: '🇪🇬' },
    { code: 'ET', name: 'エチオピア', nameEn: 'Ethiopia', flag: '🇪🇹' },
  ],
  oceania: [
    { code: 'AU', name: 'オーストラリア', nameEn: 'Australia', flag: '🇦🇺' },
    { code: 'NZ', name: 'ニュージーランド', nameEn: 'New Zealand', flag: '🇳🇿' },
  ],
};

// 全地域一覧
const ALL_REGIONS = Object.keys(COUNTRY_REGIONS);

// 地域キー → 国一覧の取得
function getCountriesForRegions(regionKeys) {
  if (!regionKeys || regionKeys.length === 0) {
    regionKeys = ALL_REGIONS;
  }
  const countries = [];
  for (const key of regionKeys) {
    if (COUNTRY_REGIONS[key]) {
      countries.push(...COUNTRY_REGIONS[key]);
    }
  }
  return countries;
}

// 全地域の全国家取得
function getAllCountries() {
  return getCountriesForRegions(ALL_REGIONS);
}

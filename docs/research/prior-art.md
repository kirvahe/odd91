# Готовые решения halation

Дата: 2026-11-21 · Назначение: prior art для UXP-плагина halation в Photoshop (8-bit sRGB → linear float32 → новый слой) · Поиск: сначала русский, затем английский · Код читался онлайн (`gh api`), ничего не клонировалось и не запускалось

## Кратко

- **Готовые плагины для Photoshop есть, но без опубликованного метода.** Halation FX ($19), Halation Film Effect PRO ($29.99), +Cine ($89), Effect.app (подписка) и Dehancer заявляют «физичность», но формул не публикуют. Почти все работают от порога (Sensitivity / Threshold) и смешивают слои режимами Screen / Soft Light / Linear Dodge. Плагины с Adobe Exchange ставятся через Creative Cloud.
- **Ближайшие технические аналоги — open-source UXP-плагины на чистом JS.** [Moder4te film simulator](https://github.com/Moder4te/moderates-film-simulator): линейный свет, ядро из двух экспонент, приближённое четырьмя гауссианами, расчёт на уменьшенной копии, TPDF-дизеринг. [PixelCraft Film Emulation](https://github.com/PixelCraft2026/film-emulation-plugin) (GPL-3.0): радиусы по каналам, тайловый рендер, дизеринг. Также [Afterglow](https://github.com/M0rgenst3rn/afterglow).
- **Эталон физической модели — [spektrafilm](https://github.com/andreavolpato/spektrafilm) и его GLSL-порт в [vkdt](https://github.com/hanatos/vkdt/tree/master/src/pipe/modules/filmsim).** Halation складывается с экспозицией (additive). Три «отскока» — гауссианы σ·√k с весами 1, ½, ¼. Сила по каналам R/G/B = 0.05 / 0.015 / 0. Результат ренормализуется делением на (1 + a).
- **Подтверждается в нашем дизайне:** линейный свет; отсутствие порога (ENS Louis-Lumière измерила, что halation линейна и аддитивна в линейном свете); ядро «яркая сердцевина + длинный слабый хвост», собранное из нескольких блюров. Так же устроены Proosa, spektrafilm, Moder4te, NST_Halation, Resolve (primary + secondary glow) и Filmbox (halation + Aura).
- **Противоречит дизайну или требует доработки:**
  1. Почти все «физичные» реализации нормируют энергию: `out = (lin + a·H) / (1 + a)`. Без нормировки и без порога плоские области получают общий красный сдвиг, и тезис «ореол виден только вокруг светов» перестаёт выполняться.
  2. Параметры по каналам различаются. Зелёный вклад составляет 0.07–0.35 от красного, синий около 0. В ряде моделей у зелёного ещё и меньший радиус, поэтому ядро ореола оранжевое, а хвост красный.
  3. Физическое ядро от точечного источника — кольцо, а не гауссиана: полное внутреннее отражение в подложке даёт r_c ≈ 0.22–0.24 мм, это около 0.6 % ширины кадра 35 мм. У протяжённых источников кольца сливаются в «ядро + хвост».
- **Пробелы, которые мы можем закрыть:** нормировка энергии, независимость от разрешения, восстановление клипнутых светов в 8-bit, дизеринг на выходе, пользовательская кривая линеаризации (её нет ни у кого), работа без CC.

## 1. Готовые инструменты для Photoshop

| Инструмент | Тип | Цена | Без CC? | Как моделирует halation (по документации) |
|---|---|---|---|---|
| [Halation FX](https://exchange.adobe.com/apps/cc/c83ce2ec/halation-fx-halation-plugin-for-photoshop) (NUUGRAPHICS) | Плагин Adobe Exchange; в карточке тип указан как «UXP or CEP plugin». PS 23.0+, 40.6 КБ, v1.0.0 от 16.04.2026 | [$19](https://exchange.adobe.com/apps/browse/cc/?q=halation&sort=RELEVANCE) | Нет: распространяется через Exchange / CC | Заявлены «per-channel blur», контролы Strength, Spread, Sensitivity, Soften, Hue, Saturation. 9 пресетов: CineStill 800T/400D, Vision3 500T/250D, Kodachrome 64, Ektachrome, Subtle, Medium, Anamorphic. Результат — группа слоёв «Halation FX» с режимами Screen / Lighten / Linear Dodge / Soft Light. Формулы не опубликованы. Судя по размеру 40 КБ и группе слоёв, эффект, вероятно, собирается штатными фильтрами и слоями Photoshop (наше предположение) |
| [Halation Film Effect PRO](https://exchange.adobe.com/apps/cc/3e8b749b/halation-film-effect) (Ah Photography) | Exchange, PS 22.0+, 31 КБ, v1.0.3 от 01.12.2025 | [$29.99](https://exchange.adobe.com/apps/browse/cc/?q=halation&sort=RELEVANCE) | Нет (Exchange) | «Soft glow around bright areas» на отдельном слое. Метод не документирован |
| [+Cine Film Emulation Plugin](https://cinegrading.com/products/cine-film-emulation-plugin-for-photoshop) (CINEGRADING) | Файл .ccx, продаётся напрямую. Требует английский интерфейс Photoshop | $89 (скидка с $129) | .ccx штатно ставится через CC / UPIA | Halation с цветовыми пресетами (Classic Red, Golden Aura, Halo, Azure Glow) и opacity. Метод не документирован |
| [Film Lab FX](https://exchange.adobe.com/apps/cc/68990f2f/film-lab-fx-film-emulation-plugin) (NUUGRAPHICS) | Exchange | $59 | Нет | 50 плёночных пресетов; halation — отдельный контрол в именованной группе слоёв ([описание](https://nuugraphics.com/blogs/pushed-pulled/how-to-create-film-halation-effect-photoshop)). Метод не документирован |
| [Effect.app для Photoshop](https://effect.app/photoshop) | Собственный инсталлятор, пункт меню Filter. PS 2022+, только RGB 8-bit, рендер локально на GPU | Подписка ([pricing](https://effect.app/pricing)) | Ставится без CC, но для запуска и загрузки эффектов нужен онлайн-вход | Контролы threshold, spread, tint ([страница эффекта](https://effect.app/effects/halation)). Формул нет |
| [Dehancer для Ps / LrC / C1 / APh](https://www.dehancer.com/shop/pslr/film) | Собственный плагин (не Exchange) | Цену со страницы извлечь не удалось | Не проверено | Самая подробно описанная модель (см. §2.2): Source Limiter, Background Gain, Smoothness, Local / Global Diffusion, Amplify, Hue, Blue Comp, Impact |
| [Film Emulation](https://github.com/PixelCraft2026/film-emulation-plugin) (PixelCraft2026) | Open-source UXP (GPL-3.0), публичная бета для Windows, PS 23.3+ | Бесплатно | .ccx | См. §3 |
| [moderates-film-simulator](https://github.com/Moder4te/moderates-film-simulator) | Open-source UXP на JS (лицензия не указана), есть пресет CineStill 800T | Бесплатно | .ccx | См. §3 |
| [Afterglow](https://github.com/M0rgenst3rn/afterglow) | UXP на JS (лицензия не указана) | Бесплатно | .ccx | Halation — «кольцо» как разность широкого и узкого блюра, цвет #ff4a1a, наложение Screen ([core.js](https://github.com/M0rgenst3rn/afterglow/blob/HEAD/glow/core.js)) |
| [spektrafilm-8bf](https://github.com/FartherOut/spektrafilm-8bf) | Фильтр .8bf на C для Photoshop-совместимых хостов, Windows, GPL-3.0 | Бесплатно | Да: .8bf копируется в папку Plug-ins | Порт spektrafilm: highlight boost → scatter → 3-bounce halation с σ первого отскока по каналам ([roadmap](https://github.com/FartherOut/spektrafilm-8bf/blob/HEAD/docs/HALATION_SYSTEM_ROADMAP.md)) |
| Экшены и оверлеи: [Pro Film Emulation](https://exchange.adobe.com/apps/cc/201489/pro-film-emulation) ($4.99), [Cinematic Halation Overlays](https://exchange.adobe.com/apps/cc/205290/cinematic-halation-overlays) (52 JPG, $11.99), [Photoshop Halation Effect](https://supply.family/shop/photoshop-halation-effect/) (2 пресета) | Экшены / оверлеи | $5–12 | Покупка через Exchange — через CC | Оверлеи-картинки или стек блюров. Метод не документирован |
| Ручной рецепт [NUUGRAPHICS](https://nuugraphics.com/blogs/pushed-pulled/how-to-create-film-halation-effect-photoshop) | Туториал | — | — | Color Range → Highlights; два слоя Halation Tight и Halation Wide; Gaussian Blur (в примере 12 px); заливка около #84362f; Screen, а для мелких жёстких источников Linear Dodge (Add) |
| [Halo Pro](https://halopro.app/) | Отдельное приложение для macOS, не плагин | Бесплатно для личного использования, €20 разово | Да | Качественная [техническая заметка](https://halopro.app/notes.html): ядро + хвост; кольцо вокруг точечных источников пока не рисует (признано в разделе Limits) |

**Установка без Creative Cloud.** Плагины Exchange ставятся через CC Desktop. Adobe документирует установку .ccx из командной строки через UPIA: `UnifiedPluginInstallerAgent.exe /install c:\myfile.ccx` ([helpx, рус.](https://helpx.adobe.com/ru/creative-cloud/apps/integration-with-other-apps/manage-plugins/install-plugins-using-upia-tool.html)). Ручная распаковка .ccx в папку Plug-ins показана в видеоинструкциях ([пример](https://www.youtube.com/watch?v=BY9-3mhR3Vc)); это неофициальный путь, его надо проверить на PS 24.4+. Фильтры .8bf и собственные инсталляторы (Effect.app, Dehancer) от CC не зависят.

**Русскоязычный сегмент.** Русские запросы дали в основном видеоуроки и [статью Dehancer «Как работает Halation»](https://dehancerru.wordpress.com/2020/08/08/halation/) — главный русскоязычный первоисточник. Русскоязычного плагина halation для Photoshop и обсуждений таких плагинов в выдаче не нашлось. Telegram и VK поиском не индексируются.

## 2. Соседние инструменты и их методы

### 2.1 DaVinci Resolve: Halation FX и Film Look Creator (Studio)

Источник: [мануал Resolve 21, гл. 157](https://docs.imaster.org/davinci-resolve-21-manual/part-12-resolve-fx-overview/ch.-157-resolve-fx-film-emulation) (зеркало). Формулы закрыты, но набор контролов раскрывает модель:

- **Processing Color Space** — эффект считается в выбранном пространстве (по умолчанию timeline).
- **Isolation**: Threshold (нижний клип источника), Normalization (верхний клип), Film Saturation Level (выше этого уровня цвет источника обесцвечивается до белого, полезно для HDR), View Isolated Regions.
- **Dye Layer Reflections**: Strength, Gamma (форма спада), Saturation, Spread и **Fine Tune Relative Spread** — отдельные расстояния отражения для R, G и B.
- **Secondary Glow**: Strength, Gamma, Spread, Filter — второй, широкий лепесток.
- **Global**: View Glow Alone; **Reduce Highlights** (не осветлять сам источник, оставить ореол по краям); Aspect Ratio (анаморф); Detail Loss.
- **Film Look Creator** — упрощённая версия: Highlights Only, Amount, Radius, Saturation, Hue. Мануал предупреждает, что Halation даёт неожиданный результат, если изображение не заполняет кадр. Cullen Kelly оценивает новый halation в FLC заметно выше прежнего плагина ([Frame.io](https://blog.frame.io/2024/08/15/what-is-resolves-new-film-look-creator-plugin/)).

Вывод: Resolve строит двухмасштабный ореол с порогом и с отдельными радиусами по каналам.

### 2.2 Dehancer (OFX, Photo Edition, плагин для Ps/LrC)

Источник: [«Как работает Halation»](https://dehancerru.wordpress.com/2020/08/08/halation/) (П. Косенко, Д. Новак, Д. Свинарчук). Это лучший описательный разбор модели среди коммерческих продуктов.

- **Физика в их изложении.** Отражённый свет теряет сине-зелёную часть и засвечивает в основном красный слой, ближайший к подложке. При сильной засветке частично засвечивается и зелёный слой, тогда ореол оранжевый. Внутри ореола оттенок плавно меняется от оранжевого у источника к красному на удалении. Светодиоды почти не дают ореолов: в их спектре мало красного. На 16 мм ореолы относительно кадра крупнее, чем на 35 мм; на 65 мм они малы.
- **Параметры:**
  - **Source Limiter** и **Background Gain** задают, насколько контрастной должна быть граница «источник / фон». Ореол различим только с тёмной стороны границы.
  - **Smoothness** распределяет эффект между крупными и точечными источниками.
  - **Local Diffusion** — радиус.
  - **Global Diffusion** — вторичная засветка средних тонов красным; по их словам, «благотворно» утепляет кожу.
  - **Amplify** — энергия засветки; чем выше, тем оранжевее ядро.
  - **Hue** — чувствительность зелёного слоя относительно красного: 0 — чисто красный ореол, 50 — оранжевое ядро и красный хвост, 100 — оранжевый по всей длине.
  - **Blue Comp.** компенсирует ослабление ореола на холодном фоне.
  - **Impact** — по сути opacity.
  - **Defringe** подавляет хроматические аберрации, иначе цветные каймы тоже порождают ореол.
  - **Mask Mode** показывает ореол отдельно от изображения.

### 2.3 Filmbox (Video Village)

Источник: [User Guide → Halation](https://videovillage.com/learn/filmbox/full-guide/negative/halation).

- **Gauge**: размер спада задаётся форматом кадра.
- **Radius**, **Strength**, **Sharpness**.
- **Aura** — отдельный ореол очень большого радиуса. Он появляется в дополнение к обычному мелкому halation, когда с негатива снят противоореольный слой (как у CineStill). У Aura свои размер и сила, а также параметр вклада зелёного канала (оранжевее или краснее).
- **Color**: насыщенность и RGB-баланс.

Filmbox требует scene-referred значения, потому что grain и halation зависят от уровней пикселей ([Grading with Filmbox](https://videovillage.com/learn/filmbox/full-guide/grading-with-filmbox)).

### 2.4 FilmConvert Halation

Источник: [страница продукта](https://www.filmconvert.com/plugin/halation). Отдельный плагин или дополнение к Nitrate, от $39, разовая покупка, 3 активации. Пользователь выбирает входную гамму (ACES, Linear, DWG, HDR). Метод сформулирован только как «mimics where halation would naturally occur»; в остальном не документирован.

### 2.5 Колористы: liftgammagain и Mixing Light

- **Hendrik Proosa** ([liftgammagain, стр. 5](https://liftgammagain.com/forum/index.php?threads/halation-and-gate-weave.13056/page-5)):
  - работает только в scene-linear: `ACEScct > ACEScg > halation > ACEScct`;
  - блюр — «concatenated 4-level gaussian»: каждый следующий уровень имеет вдвое больший радиус и половинный вес;
  - из операций только multiply (цвет и сила) и plus (сложение с оригиналом);
  - добавленную красноту снимает масштабированием RGB, коэффициент «можно рассчитать автоматически» из цвета и силы;
  - по его словам, «proper halation simulation should… be energy conserving».
- **Jussi Rovanpera** там же предлагает стек нескольких гауссовых glow разных радиусов.
- **Mixing Light** ([Joey D'Anna](https://mixinglight.com/color-grading-tutorials/emulating-film-halation-in-davinci-resolve/)) описывает два метода. Первый: LogC → linear, выделение светов кривой, Layer Mixer, блюр красного и зелёного каналов. Второй: маска из edge detect и расширенного luma key.

### 2.6 Nuke: NST_Halation (Nuke Survival Toolkit, Tony Lyons)

Источник: [NST_Halation.gizmo](https://github.com/CreativeLyons/NukeSurvivalToolkit_publicRelease/blob/HEAD/NukeSurvivalToolkit/gizmos/NST_Halation.gizmo).

1. Luma key: Grade с blackpoint/whitepoint и white clamp.
2. Три Glow размером ×1, ×2, ×4, объединённые через screen.
3. Вычитание ключа (merge `from`), чтобы ореол оставался вне источника.
4. Max с блюром.
5. Поканальный множитель red / green / blue и Global Amount.

## 3. Open-source реализации

### 3.1 Сводка по ключевым вопросам

| Реализация | Линеаризация | Порог | Ядро | Цвет / каналы | Сила | Смешивание и нормировка |
|---|---|---|---|---|---|---|
| [spektrafilm](https://github.com/andreavolpato/spektrafilm/blob/HEAD/src/spektrafilm/model/diffusion.py) (Python) + [vkdt filmsim](https://github.com/hanatos/vkdt/blob/master/src/pipe/modules/filmsim/halation.glsl) (GLSL) | Да: работает с экспозицией (raw irradiance) до характеристической кривой плёнки | Нет. Опционально highlight boost для восстановления клипа | N = 3 гауссианы с σ_k = σ_h·√k, веса ρ^(k−1) с ρ = 0.5. Перед этим scatter: гауссово ядро + экспоненциальный хвост | Сила по каналам (0.05, 0.015, 0.0); σ по умолчанию одинаковая (65 мкм) | `a_tot = strength_c · amount` | Аддитивно, затем `/(1 + a_tot)` (`halation_renormalize = True`) |
| [thatcherfreeman Halation.dctl](https://github.com/thatcherfreeman/utility-dctls/blob/HEAD/Effects/Halation.dctl) | Требует линейный вход | Нет | Gaussian или exponential, на выбор | Источник = dot(rgb, film_base), film_base = (1, 0.1, 0.1)/1.2. Радиусы R < G < B: 3.0 / 3.2 / 3.3 ‰ ширины кадра | Потери в стопах: R −3, G дополнительно −1.4, B ещё −1.4 | Аддитивно + «Red Shift Correction»: усиление (белое остаётся белым) или обратная матрица 3×3 (по умолчанию) |
| [hotgluebanjo halation-dctl](https://github.com/hotgluebanjo/halation-dctl/blob/HEAD/halation.dctl) | Требует scene-linear | Нет, edge detect принципиально не используется | `exp(−r/r0)`, двумерное несепарабельное, радиус окна 4.5·r0 | color = (1, c, 0), c = 0.15 («сколько света проходит через зелёный слой») | Размер ядра; сила задаётся через c | Метод Proosa: `(rgb + blur·color) / (1 + color)` — нормировка по каналам |
| [Moder4te](https://github.com/Moder4te/moderates-film-simulator/blob/HEAD/core/optics/halation.js) (UXP JS) | Да, `v^γ` через таблицу | Мягкое колено `(lin − knee)/(1 − knee)` по красному каналу | 0.6·Exp(0.6R) + 0.4·Exp(2.0R), приближено четырьмя гауссианами, каждая — 3 box-блюра на уменьшенной копии | Источник — только R; цвет LAYER = (1.0, 0.07, 0.01) | 0.036 линейного усиления на единицу ползунка (50 → 1.8) | Аддитивно, без нормировки. 8-bit: TPDF-дизеринг ±1 LSB |
| [PixelCraft Film Emulation](https://github.com/PixelCraft2026/film-emulation-plugin/blob/HEAD/src/core/params.js) (UXP JS, GPL-3.0) | Да (linear / stops) | Да: threshold 0.7 linear, smoothstep, плюс background gating | «Трёхлепестковая PSF», σ = 7 px (или ‰ диагонали), быстрый режим через три box-блюра | Радиусы по каналам 1.0 / 0.55 / 0.35 от σ; усиления redshift (1.0, 0.12, 0.02) | strength 0–100 → α | additive (по умолчанию) или screen; опциональный soft rolloff выше 1 при записи в 8/16-bit; модуль dither |
| [ComfyUI-Darkroom](https://github.com/jeremieLouvaert/ComfyUI-Darkroom/blob/HEAD/docs/halation-derivation.md) (Python) | sRGB → linear | Нет (knee по умолчанию 0: «ALL light halates») | **Кольцо от TIR** `P_TIR(r) ∝ R_Fresnel(θ)/(1+(r/2d)²)²` + экспоненциальный хвост, баланс 0.65/0.35 | Веса R > G > B, пресет CineStill (1, 0.32, 0.10); противоореольный слой гасит ореол множителем (1−ah)² | strength 0–1 → доля 0–0.25 | Аддитивно в линейном свете, затем clip. Нормировано ядро, но не изображение |
| Антипримеры: [FUTC halations](https://github.com/FUTC-Coding/halations/blob/HEAD/src/photonworker.js) (JS), [Georj01](https://github.com/Georj01/davinci-dctl/blob/HEAD/Color/Film_Halation.dctl) (DCTL) | Нет, всё в гамме | Да, жёсткий (бинарный threshold / luma − 0.8) | Один гауссиан / 3×3 тапа | Чистый красный / tint (1, 1−0.6b, 1−b) | — | Screen в 8-bit / сложение без нормировки |

### 3.2 Что именно заимствовать

**spektrafilm (основная модель).** Значения по умолчанию из [params_schema.py](https://github.com/andreavolpato/spektrafilm/blob/HEAD/src/spektrafilm/runtime/params_schema.py):

```text
a_c   = halation_strength_c · amount          # R,G,B = 0.05, 0.015, 0.0
σ_k   = σ_h · sqrt(k),  k = 1..N               # σ_h = 65 мкм, N = 3
w_k   = ρ^(k−1) / Σ_j ρ^(j−1)                  # ρ = 0.5 → 4/7, 2/7, 1/7
H_c   = Σ_k w_k · Gauss(σ_k) ⊛ E_c
E'_c  = (E_c + a_c · H_c) / (1 + a_c)          # renormalize
```

- **Перевод радиуса в пиксели** в vkdt: `σ_px = σ_мкм · max(W, H) / 35000` ([main.c](https://github.com/hanatos/vkdt/blob/master/src/pipe/modules/filmsim/main.c), [constants.h](https://github.com/hanatos/vkdt/blob/master/src/pipe/modules/filmsim/constants.h)). Радиус задаётся долей кадра, поэтому от разрешения не зависит.
- **Экспонента через гауссианы** ([fast_gaussian_filter.py](https://github.com/andreavolpato/spektrafilm/blob/HEAD/src/spektrafilm/utils/fast_gaussian_filter.py)). `exp(−r/λ)` приближается так (пары «амплитуда, σ/λ»):
  - 2 гауссианы: (0.6235, 0.9401), (0.3765, 2.5177);
  - 3 гауссианы: (0.1633, 0.5360), (0.6496, 1.5236), (0.1870, 2.7684).
- **Восстановление клипнутых светов** (`boost_highlights`). Выше порога `x0`: `y = x + max·k·(exp(a·dx) − a·dx − 1)`, где `dx = (x − x0)/max`.
- **Поправка на средние тона в vkdt.** В [halation.glsl](https://github.com/hanatos/vkdt/blob/master/src/pipe/modules/filmsim/halation.glsl) сила ослабляется в средних тонах (параметр `hal mids`). Итог: `(raw + hs·hal)/(1 + hs)`.

**thatcherfreeman.** Два полезных приёма:
- радиус в промилле ширины кадра;
- коррекция «Red Shift»: отклик на чистые R, G, B собирается в матрицу 3×3, и результат умножается на обратную матрицу, чтобы нейтральные поля оставались нейтральными.

**hotgluebanjo.** Предупреждения из [README](https://github.com/hotgluebanjo/halation-dctl): у гауссова или box-блюра «плохой спад»; встречается бандинг, когда область затухания распадается на две цветовые полосы; излишне тонируются сами света; edge detection работает слишком агрессивно.

**Moder4te (ближе всего к нашему стеку).**
- Ядро из четырёх гауссиан: σ = {0.3, 0.75, 1.7, 4.0}·R, веса {0.0631, 0.3552, 0.3707, 0.211}, в сумме 1. Энергия сохраняется; по комментарию автора, отклонение от целевой кумулятивной энергии меньше 2 %.
- Гауссиана считается тремя box-проходами по Kutskir (O(1) на пиксель независимо от радиуса).
- Источник уменьшается усреднением по площади так, чтобы наименьшая σ оставалась не меньше 2 px. Обратное увеличение — билинейное.
- По краям значения продлеваются (clamp-to-edge), поэтому источник у рамки не темнеет.
- Обратное кодирование — через таблицу на 4096 точек с равным шагом в √L.
- Детерминированный TPDF-дизеринг тайлом 64×64.
- **Ключевая заметка о производительности:** UXP работает так, будто JIT нет. Код, который в Node выполнялся 1.7 с, в UXP занял 12 с; `node --jitless` воспроизвёл это (14 с). Поэтому в пиксельных циклах убраны `Math.pow`, замыкания и деления, а производительность проверяется с `--jitless`.
- Лицензия не указана: код копировать нельзя, идеи использовать можно.

**PixelCraft.** Отношение радиусов по каналам R:G:B = 1 : 0.55 : 0.35 при усилениях 1 : 0.12 : 0.02. Отдельный параметр rolloff для значений выше 1 перед записью в 8/16-bit. Тайловый и потоковый рендер ([streamRender.js](https://github.com/PixelCraft2026/film-emulation-plugin/blob/HEAD/src/io/streamRender.js)). Режимы отладки. GPL-3.0: идеи да, код в закрытый плагин нельзя.

**ComfyUI-Darkroom.** Единственная найденная реализация, где кольцо выведено из геометрии полного внутреннего отражения. Вывод и тесты («teeth») в их документе стоит взять за образец:
- положение пика кольца;
- сохранение энергии ядра;
- порядок весов R > G > B;
- при strength = 0 результат побитово совпадает со входом;
- независимость от разрешения (512 и 2048 px, допуск 15 %);
- монотонность по strength.

## 4. Физика и типичные значения

**Механизм.**
- Свет проходит эмульсию и рассеивается в подложку. На её задней поверхности (граница с воздухом) лучи под углом больше критического, около 41–42° при n ≈ 1.5, полностью отражаются (TIR). При почти нормальном падении отражается около 4 % (Френель).
- Отражённый свет возвращается в эмульсию снизу и засвечивает красночувствительный слой. Источники: [NBS Scientific Paper 439 (Davis & Walters, 1922)](https://nvlpubs.nist.gov/nistpubs/ScientificPapers/nbsscientificpaper439vol18p1_A2b.pdf); [Halo Pro notes](https://halopro.app/notes.html); [вывод ComfyUI-Darkroom](https://github.com/jeremieLouvaert/ComfyUI-Darkroom/blob/HEAD/docs/halation-derivation.md); [analog.cafe](https://www.analog.cafe/r/halation-in-film-photography-i3q4).
- В NBS прямо сказано, что размер ореола определяется толщиной подложки и критическим углом.
- В моделировании 2001 года ([«Model examination of the reflex-halation…»](http://dbc.wroc.pl/Content/40635)) у PSF и LSF есть максимумы на кольце ореола, диаметр кольца зависит от толщины подложки, критический угол 41°8′. По этой теме есть и советская работа: [Vendrovskii & Pakoushko, 1964](https://doi.org/10.1080/00223638.1964.11737228) (прочитана только аннотация).

**Почему красный.**
- Порядок слоёв сверху вниз: синечувствительный → жёлтый фильтр → зелёный → красный. Коротковолновый свет поглощается по пути вниз, и первым на обратном пути свет встречает красный слой ([Dehancer](https://dehancerru.wordpress.com/2020/08/08/halation/), [Halo Pro](https://halopro.app/notes.html)).
- Halo Pro отмечает: где возврат сильный, красный близок к насыщению, а зелёный продолжает расти, поэтому самая яркая часть ореола выглядит оранжевой.

**Противоореольные слои.**
- Remjet — слой сажи на обороте кинонегатива, смывается при проявке ([Dehancer](https://dehancerru.wordpress.com/2020/08/08/halation/)).
- В 2025 году Kodak перевела Vision3 на структуру **AHU** ([Kodak, talking points](https://www.kodak.com/content/pdfs/motion/AHU-talking-points.pdf)): без remjet, с противоореольным подслоем под эмульсией, который содержит серебро и удаляется в процессе. По заявлению Kodak, AHU «controls halation even more successfully than remjet». Для источников на 8 и более стопов выше нормы Kodak советует тестировать, а полированные хромированные прижимные столики могут давать дополнительный засвет.
- CineStill снимает remjet, поэтому halation возвращается. В FAQ CineStill причиной названо отражение «inside the film base or off of the pressure plate» ([FAQ](https://cinestillfilm.com/pages/frequently-asked-questions)). Analog.cafe спорит с версией про прижимной столик и считает главным TIR на границе подложки с воздухом.
- Filmbox называет большой ореол плёнки без противоореольного слоя отдельным явлением — Aura ([guide](https://videovillage.com/learn/filmbox/full-guide/negative/halation)).

**Измерение ENS Louis-Lumière (2023), Vision3 500T, 35 мм, с remjet** ([PDF](https://www.ens-louis-lumiere.fr/wp-content/uploads/2024/02/ENSLL_PHOTO_MONTMEA_2023-English-Fev.pdf)):
- halation **аддитивна и линейна в линейном свете**: отношение ореол / освещённая сторона постоянно в диапазоне экспозиций +5…+11;
- ядро — одна гауссиана, σ подбиралась в диапазоне 4–8 px при шаге скана 6 мкм/px, то есть 24–48 мкм;
- реализация в их пайплайне: `(img + hal·coef)/(1 + coef)`.
- Коэффициенты после коррекции фильтрации: R ≈ 0.12–0.17. Порядок G и B в извлечённых таблицах противоречив: в одной G ≈ 0.04–0.06 и B ≈ 0.07–0.10, в другой G > B. Сторонний пересказ ([kallo-core](https://docs.rs/kallo-core/latest/kallo_core/halation/)) даёт R 0.12–0.13, G 0.066, B 0.037. **Надёжный вывод один: G и B ненулевые, R доминирует.** Перед использованием проверить по рис. 31 и 36 PDF.

**Типичные размеры.** Пересчёт на кадр 36 мм / 6000 px, то есть около 6 мкм на пиксель, это 24 Мп:

| Величина | Значение | Доля длинной стороны | px при 6000 |
|---|---|---|---|
| Толщина подложки | 125–135 мкм ([Darkroom](https://github.com/jeremieLouvaert/ComfyUI-Darkroom/blob/HEAD/docs/halation-derivation.md), [kallo-core](https://docs.rs/kallo-core/latest/kallo_core/halation/struct.Halation.html), ENS) | — | — |
| Радиус TIR-кольца `r_c = 2d/√(n²−1)` при n = 1.5 | 224–241 мкм (Halo Pro: «about 0.23 mm») | 0.62–0.67 % | 37–40 |
| σ первого отскока в spektrafilm | 65 мкм; 92 и 113 мкм для k = 2, 3 | 0.18 % / 0.26 % / 0.31 % | 11 / 15 / 19 |
| σ по измерению ENS (500T с remjet) | 24–48 мкм | 0.07–0.13 % | 4–8 |
| Радиус по умолчанию у thatcherfreeman | 3 ‰ ширины, std = r/2 | 0.3 % (std 0.15 %) | 18 (std 9) |
| Хвост по умолчанию у Darkroom | 40 опорных px при 1024 | ~3.9 % | ~234 |
| Зеркальное отражение конуса объектива ([kallo-core](https://docs.rs/kallo-core/latest/kallo_core/halation/)) | f/1.4: 62 мкм; f/4: 22 мкм; f/16: 5.6 мкм | — | — |

Сила: spektrafilm по умолчанию R/G/B = 0.05 / 0.015 / 0; Darkroom описывает реальную halation как «single-digit-% of incident energy»; ENS — см. выше. Формат: на 16 мм ореол крупнее относительно кадра ([Dehancer](https://dehancerru.wordpress.com/2020/08/08/halation/), Filmbox Gauge).

## 5. Пробелы существующих решений

1. **Гамма-пространство и режимы наложения.** Коммерческие плагины для PS смешивают слои через Screen / Soft Light / Linear Dodge, то есть не в линейном свете. Screen не равен сложению света; Linear Dodge в 8-bit sRGB складывает закодированные значения.
2. **Нет нормировки энергии.** Из коммерческих продуктов нормировку не документирует никто. В open-source её делают spektrafilm, vkdt, hotgluebanjo, thatcherfreeman и пайплайн ENS. Без неё сила меняет баланс белого всей картинки.
3. **Зависимость от разрешения.** Радиус в пикселях у hotgluebanjo (1 px по умолчанию), у PixelCraft по умолчанию, у Georj01. Долей кадра его задают spektrafilm/vkdt (мкм), thatcherfreeman (‰), Afterglow (% высоты), Darkroom (опорные px при 1024) и Filmbox (Gauge).
4. **Клипнутые источники в 8-bit.** Реальные источники на 8+ стопов ярче нормы ([Kodak](https://www.kodak.com/content/pdfs/motion/AHU-talking-points.pdf)), а в 8-bit их энергия ограничена 1.0. Ореол получается слабым, а при увеличении силы засвечиваются средние тона. Специальный механизм восстановления есть только у spektrafilm (highlight boost); у Resolve есть Normalization / Film Saturation Level, у Dehancer — Amplify.
5. **Нет градиента оттенка от оранжевого к красному.** Большинство использует один плоский tint. Градиент есть у Dehancer (Hue и Amplify), PixelCraft (σ по каналам) и Resolve (Relative Spread).
6. **Нет кольца.** Структуру TIR вокруг точечных источников моделирует только ComfyUI-Darkroom; Halo Pro признаёт, что пока её не рисует.
7. **Бандинг на выходе.** Гладкие ореолы в 8-bit дают полосы. Дизеринг делают только Moder4te (TPDF) и PixelCraft; hotgluebanjo описывает бандинг как типовую проблему. Blue-noise дизеринга не нашли ни у кого.
8. **Ложные ореолы от хроматических аберраций.** Учитывает только Dehancer (Defringe).
9. **Пользовательская линеаризация.** Ни один инструмент не даёт редактировать кривую линеаризации: все предполагают sRGB / гамму или выбор camera log.
10. **Доступность в России.** Exchange-плагины требуют CC. Без CC работают .8bf (spektrafilm-8bf) и собственные инсталляторы, причём Effect.app требует онлайн-вход.

## 6. Рекомендации для нашего алгоритма

1. **Сделать нормировку энергии (режим по умолчанию).** `out_c = (lin_c + s·w_c·H_c) / (1 + s·w_c)` — схема Proosa, spektrafilm и ENS. При отсутствии порога это обязательно: иначе каждый пиксель добавляет красное, и ровный серый получает общий тёплый сдвиг. С нормировкой плоское нейтральное поле не меняется, ореол виден только на контрастных границах (что и обещает дизайн), а сердцевина источника слегка теряет энергию, которая уходит в ореол. Режим «без нормировки» оставить как творческую опцию.
2. **Писать в новый слой полный результат в режиме Normal, а не «только ореол» в Linear Dodge.** Сложение в линейном свете не выражается штатными режимами наложения в 8-bit sRGB. Нормировка требует затемнения, а слой с отрицательными значениями в 8-bit невозможен. Вид «только ореол» дать как отладочный режим (аналог Dehancer Mask Mode и Resolve View Glow Alone).
3. **Источник взвешивать по красному, а не по яркости.** Например `S = 0.83·R + 0.083·G + 0.083·B`, как у thatcherfreeman, или чистый R, как у Moder4te. Яркостный источник заставляет синие и зелёные огни давать красный ореол, а это противоречит физике: светодиоды с малой долей красного почти не дают ореолов ([Dehancer](https://dehancerru.wordpress.com/2020/08/08/halation/)).
4. **Сделать ползунок «цвет» доступом к физике.** Hue задаёт долю зелёного `g` относительно красного: g ∈ [0, 0.4], по умолчанию около 0.25–0.3. Синий `b` ∈ [0, 0.1]. Эти диапазоны охватывают spektrafilm (1, 0.3, 0), Darkroom CineStill (1, 0.32, 0.10), PixelCraft (1, 0.12, 0.02) и Moder4te (1, 0.07, 0.01). Произвольный RGB-оттенок оставить в «расширенных» настройках.
5. **Задать зелёной компоненте меньший радиус, около 0.55× красного (PixelCraft).** Синему — 0.35× или общий с зелёным. Это даёт оранжевое ядро и красный хвост ([Dehancer](https://dehancerru.wordpress.com/2020/08/08/halation/), Resolve Relative Spread). Без этого в линейной аддитивной модели оттенок по всему ореолу постоянный, а оранжевое ядро появляется только из-за клипа R. Внимание: у thatcherfreeman порядок обратный (G и B чуть шире); физически обоснованным считаем вариант PixelCraft и Dehancer.
6. **Ядро «сердцевина + хвост» оставить, но строить его по экспоненте, а не по одиночной гауссиане.** Сердцевина — `exp(−r/λ)` через 3 гауссианы с коэффициентами spektrafilm (0.1633 / 0.6496 / 0.1870; σ = 0.536 / 1.524 / 2.768·λ). Хвост — второй экспоненциальный лепесток с λ₂ ≈ 3.3·λ₁ и весом около 0.4, по схеме Moder4te 0.6·Exp(0.6R) + 0.4·Exp(2.0R). Для пресета CineStill добавить «Aura» по образцу Filmbox: λ₃ ≈ 1–4 % длинной стороны, вес 0.1–0.2. Веса нормировать так, чтобы ∫K = 1.
7. **Радиус задавать долей длинной стороны.** Стартовые значения — синтез источников из §4, а не измерения. λ₁ ≈ 0.15–0.2 % длинной стороны, это 9–12 px при 6000 px и соответствует σ 65 мкм в spektrafilm. Хвост около 0.5–0.7 %, это порядок радиуса TIR-кольца. Ползунок «Размытие» должен быть множителем ×0.25…×4. Добавить переключатель формата 35 мм / 120 / 16 мм, который масштабирует радиус (Filmbox Gauge, Dehancer).
8. **Сила — физическая доля возвращённого света.** Ползунок 0–100 линейно отображается в a_R ∈ [0, 0.25] (как у Darkroom), по умолчанию a_R ≈ 0.05–0.08 (spektrafilm 0.05, ENS для 500T около 0.12). Значения g и b берутся из п. 4.
9. **Опционально — «Яркость источников» для клипнутых пикселей 8-bit.** Пикселям с каналом 255 (или со значением выше колена ~0.95 linear) умножать вклад в S на 1…16, по умолчанию около 4. Либо кривая boost из spektrafilm: `y = x + k·(e^{a·dx} − a·dx − 1)` выше x0. Без этого пользователь будет выкручивать силу, и засветятся средние тона.
10. **Порог по умолчанию 0, мягкое колено как опция.** Отсутствие порога подтверждают ENS (аддитивность и линейность), Darkroom (knee = 0) и Proosa. Опцию вроде Source Limiter у Dehancer или smoothstep-порога у PixelCraft оставить «для вкуса», выключенной.
11. **Производительность в UXP:**
    - halation — низкочастотный эффект, поэтому считать на уменьшенной копии (наименьшая σ не меньше 2 px) и увеличивать билинейно (Moder4te);
    - каждую гауссиану — тремя box-проходами (Kutskir);
    - на краях clamp-to-edge;
    - 8-bit → linear через LUT[256], linear → 8-bit через LUT на 4096+ точек; кастомная кривая и её обратная тоже запекаются в LUT;
    - в пиксельных циклах не вызывать `Math.pow` и функции, не делить; производительность проверять через `node --jitless`;
    - большие документы обрабатывать тайлами (PixelCraft streamRender).
12. **Выход.** После сложения мягкое плечо выше 1.0 как опция (PixelCraft rolloff), иначе clip; затем обратная кривая и blue-noise дизеринг ±0.5–1 LSB один раз при финальном квантовании. Наш blue noise — преимущество: у конкурентов либо ничего, либо TPDF.
13. **Тесты по образцу Darkroom:**
    - при strength = 0 результат побитово совпадает со входом;
    - плоское нейтральное поле инвариантно (проверка нормировки);
    - энергия ядра равна 1;
    - монотонность по силе;
    - независимость от разрешения (512 и 2048 px, допуск 15 %);
    - порядок вклада R > G > B.
14. **v2: кольцо TIR для точечных источников.** `P_TIR(r) ∝ R_Fresnel(θ)/(1 + (r/2d)²)²` с r_c ≈ 0.62 % ширины 35 мм (Darkroom). Видно только вокруг точечных огней; ни у одного PS-плагина этого нет, так что это возможная отличительная функция.
15. **Дистрибуция для пользователя в России.** Описать и проверить установку .ccx без CC на PS 24.4+ (UPIA из командной строки или распаковка в Plug-ins). Если путь ненадёжен, рассмотреть как резерв формат .8bf, который ставится копированием, как у spektrafilm-8bf.

## Методика и ограничения

- **Запросы.** Русский: «халация фотошоп плагин», «как сделать халацию… CineStill 800T», «плагин halation… экшен», «установить .ccx без Creative Cloud». Английский: поиск плагинов, Resolve, Filmbox, Kodak remjet, CineStill, техническая физика. Исходный код читался через GitHub API.
- **Бюджет.** 31 вызов Firecrawl/Exa: 11 поисков Firecrawl, 18 скрейпов, 2 поиска Exa. Около 172 кредитов Firecrawl, из них 110 ушло на один PDF ENS.
- **Не прочитано.** Reddit: навык reddit-research был опционален и не запускался, мнения сообщества Reddit в отчёт не входят. Платные материалы Mixing Light. Полный текст статьи Vendrovskii & Pakoushko 1964 (только аннотация).
- **Не установлено.** Цена и способ активации Dehancer для PS. Внутренние формулы Resolve, Filmbox, FilmConvert, Halation FX и +Cine (закрыты, помечено «не документирован»). Точный порядок G и B в таблицах ENS (см. §4).

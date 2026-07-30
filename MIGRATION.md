# Преместване на сървъра на друга машина

Целта на този документ: **нищо от свършената работа да не се прави отново.**

Всяка настройка, която сме наглаждали, вече е записана в git. Живите `.conf`
файлове са нарочно извън git (съдържат паролата за MySQL), затова настройките се
пазят отделно в `setup\server-settings.conf` и се възстановяват със скрипт.

---

## Два маршрута — избери един

| | Маршрут A — копиране | Маршрут B — пълно построяване |
|---|---|---|
| Време | ~30–60 мин | ~3–4 часа |
| Нужен компилатор | не | да (VS 2022, CMake, Boost, OpenSSL) |
| Кога | просто местиш сървъра | ще променяш C++ кода/пачовете |

**Маршрут A е препоръчителният.** Двоичните файлове са преносими между x64
машини с Windows — няма нужда да се компилира отново.

---

## 1. На СТАРАТА машина

```powershell
cd <път>\wow

# 1.1 Запиши текущите настройки (31 бр.) в git-проследявания файл
.\setup\export-settings.ps1

# 1.2 Дъмп на незаменимите данни (~4 MB: акаунти, GM права, герои, гилдии)
.\setup\backup-databases.ps1
#     -All добавя acore_world + acore_playerbots (~520 MB). Нужно е САМО ако
#     си правил ръчни промени в света (spawn-ове, loot, вендори). Иначе те
#     се пресъздават сами при първото пускане.

# 1.3 Спри сървърите ЧИСТО, преди да копираш каквото и да е
'server shutdown 1' | Set-Content .\server\cmd.txt -Encoding ascii
Start-Sleep 20
Stop-Process -Name authserver -ErrorAction SilentlyContinue

# 1.4 Качи промените
git add -A ; git commit -m "config snapshot before machine move" ; git push
```

### Какво да копираш физически (не е в git — нарочно)

| Източник | Размер | Задължително? |
|---|---|---|
| `db-backup-<дата>\` | ~4 MB | **да** — акаунтите и героите |
| `setup\CREDENTIALS.txt` | 6 KB | **да** — всички пароли |
| `setup\db-password.txt` | <1 KB | **да** |
| `cloud\agent\.env` | <1 KB | да, ако ползваш облачния агент |
| `server\` (без `logs\`) | ~3.5 GB | **Маршрут A** — двоични + данни от клиента |
| `server\Data\` | 3.08 GB | Маршрут B — спестява 1–3 ч. извличане |
| `client\` | ~15 GB | само ако играеш и от тази машина |

> `server\Data` е най-ценното за копиране и в двата маршрута. Пресъздаването му
> означава да пуснеш `mmaps_generator` — часове на лаптоп процесор.

---

## 2. На НОВАТА машина

### 2.1 Задължителен софтуер

**Маршрут A** (само това):
- **MySQL Server 8.4** — същата главна версия
- **Node.js 24.x** — за админ панела и HUD-а
- **Microsoft Visual C++ 2015–2022 Redistributable (x64)** — ⚠️ лесно се пропуска.
  Без него `worldserver.exe` умира с `0xc0000135` и нито един ред в лога.
- Git

**Маршрут B** — допълнително, и **версиите не са по избор**:

| Компонент | Версия | Защо е закована |
|---|---|---|
| VS 2022 Build Tools | MSVC **14.4x (v143)** | Boost-двоичните са `msvc-14.3`; v145 от VS 2026 не става |
| CMake | **3.31.8** | CMake 4.x чупи AzerothCore (issue #26544) |
| OpenSSL | **3.6.2 FireDaemon** | slproweb вече връща 404 за 3.x; winget дава 4.0.1, което не става |
| Boost | **1.83.0 msvc-14.3** | mod-playerbots приема 1.78–1.83; **1.87+ е счупено** |

След това: `BOOST_ROOT` = `C:/local/boost_1_83_0` (User scope е достатъчен).

### 2.2 Вземи проекта

```powershell
git clone https://github.com/dominitriks/furryofmadnesswow.git wow
cd wow
```

Копирай тук `setup\CREDENTIALS.txt`, `setup\db-password.txt`, `cloud\agent\.env`
и папката `db-backup-<дата>\`.

**Маршрут A:** копирай и цялата папка `server\`. Прескочи 2.3 и 2.4.

### 2.3 Изходен код *(само Маршрут B)*

⚠️ Ядрото и модулът са свързани — винаги ги дърпай заедно. Точните версии,
върху които този сървър работи:

```powershell
git clone https://github.com/mod-playerbots/azerothcore-wotlk.git --branch=Playerbot source
git -C source checkout ceeb3116ebedf4b35f12b75e5481b6ddd0de7a89

git clone https://github.com/mod-playerbots/mod-playerbots.git source\modules\mod-playerbots
git -C source\modules\mod-playerbots checkout 3fa1c1e49f8f1324b72461e576bce7c89b0a6521
```

Приложи локалния пач (без него ботовете отказват RDF в бой и влизат в
подземието без изчакване):

```powershell
cd source\modules\mod-playerbots
git apply ..\..\..\setup\patches\001-lfg-accept-in-combat.patch
cd ..\..\..
```

Виж `setup\patches\README.txt` за подробности.

### 2.4 Построяване *(само Маршрут B)*

Първо изключенията на Defender — иначе всяко построяване е пълно (~1 час вместо
инкрементално). Изисква администратор:

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-File','setup\02-elevated-fixes.ps1'
```

```powershell
$env:PATH="C:\Program Files\Git\cmd;C:\Program Files\CMake\bin;$env:PATH"
mkdir build; cd build

cmake "<път>/wow/source" -G "Visual Studio 17 2022" -A x64 -T host=x64 `
  -DCMAKE_INSTALL_PREFIX="<път>/wow/server" `
  -DTOOLS_BUILD=all -DSCRIPTS=static -DMODULES=static `
  -DBOOST_ROOT="C:/local/boost_1_83_0" `
  -DOPENSSL_ROOT_DIR="C:/Program Files/FireDaemon OpenSSL 3" `
  -DCMAKE_CXX_FLAGS="/DWIN32 /D_WINDOWS /EHsc /FS /MP4"

cmake --build . --config RelWithDebInfo --parallel 1
cmake --build . --config RelWithDebInfo --target install
```

⚠️ **`CMAKE_CXX_FLAGS` замества стойностите по подразбиране на CMake.** Затова
`/DWIN32 /D_WINDOWS /EHsc` трябва да се изпишат отново. Изпуснеш ли `/EHsc`,
всеки двоичен файл се проваля при свързване с
`LNK2001: boost::throw_exception`. Това вече ни струва едно цяло построяване.
`/FS` е срещу `C1041` (спор за `scripts.pdb`), `/MP4` ограничава паметта.

Провери преди построяването:
```powershell
Select-String -Path CMakeCache.txt -Pattern "^CMAKE_CXX_FLAGS:"   # трябва да съдържа /EHsc
```

**Четирите DLL-а се копират на ръка — install не копира нито един:**

```powershell
$s = "<път>\wow\server"
copy "C:\Program Files\MySQL\MySQL Server 8.4\lib\libmysql.dll" $s
copy "C:\Program Files\FireDaemon OpenSSL 3\bin\libcrypto-3-x64.dll" $s
copy "C:\Program Files\FireDaemon OpenSSL 3\bin\libssl-3-x64.dll" $s
copy "C:\Program Files\FireDaemon OpenSSL 3\lib\ossl-modules\legacy.dll" $s
```

⚠️ `legacy.dll` е в `lib\ossl-modules\`, **не** в `bin\`. Липсва ли, сървърът
прекъсва с `ASSERT` и код `-1073740768`.
⚠️ Не решавай това чрез добавяне на MySQL `bin\` към PATH — там има същите по име
OpenSSL DLL-и, които засенчват тези на FireDaemon.

Копирай `server\Data\` от старата машина и създай `mkdir server\logs`
(липсваща папка за логове **тихо изключва** записа във файл).

### 2.5 База данни

```powershell
# 1. my.ini - копирай wow\mysql\my.ini от старата машина и поправи datadir
# 2. като root:
mysql -u root -p < setup\01-create-databases.sql
```

⚠️ `01-create-databases.sql` още съдържа **старата слаба парола** `acore`.
След като го пуснеш, задай истинската (тази от `db-password.txt`):

```sql
ALTER USER 'acore'@'localhost' IDENTIFIED BY '<паролата от db-password.txt>';
```

Възстанови данните:

```powershell
.\setup\restore-databases.ps1 -From .\db-backup-<дата>
```

MySQL като услуга, за да преживява рестарт (изисква администратор):

```powershell
mysqld --install MySQL84 --defaults-file="<път>\wow\mysql\my.ini"
net start MySQL84
```

### 2.6 Настройки — тук се възстановява цялата свършена работа

```powershell
.\setup\apply-settings.ps1 -FromDist
```

Това връща и **31-те настройки**, и абсолютните пътища за *новата* машина
(извеждат се от местоположението на скрипта). Обхваща рейтовете за опит и
плячка, броя и нивото на ботовете, бойните стратегии (танкът напада пръв),
изчакването при влизане в подземие, спрените шепоти, RDF маската.

Скриптът проверява сам себе си накрая и предупреждава, ако пач 001 липсва в
изходния код, докато настройките за него присъстват.

⚠️ Ако си копирал `server\` от старата машина (Маршрут A), тази стъпка е
**задължителна** — вътрешните `.conf` файлове още сочат към стария път.

### 2.7 Мрежа

Realm адресът е единственото, което **винаги** е грешно след преместване:

```sql
UPDATE acore_auth.realmlist
   SET address      = '<публичен IP или име на хост>',
       localAddress = '<LAN IPv4 на НОВАТА машина>'
 WHERE id = 1;
```

Без рестарт — authserver презарежда на всеки 20 секунди.

⚠️ Неразрешимо име кара реалма да **изчезне тихо** от списъка, вместо да даде
грешка. Същото важи и за грешна `localSubnetMask`.

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-File','setup\06-firewall-lan.ps1'
Start-Process powershell -Verb RunAs -ArgumentList '-File','setup\07-firewall-public.ps1'
```

⚠️ **Пренасочването на портове в рутера сочи към стария LAN адрес.** Влез в
рутера (TP-Link NX220v → Advanced → NAT Forwarding → Virtual Servers) и насочи
3724 и 8085 към новия. Запази DHCP резервация за новия адрес.
⚠️ Порт 3306 (MySQL) **никога** не се пренасочва.

Ако ползваш `logon.furryofmadness.com` локално:
```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-File','setup\03-hosts-entry.ps1'
```

### 2.8 Панел, HUD, облачен агент

```powershell
cd panel        ; npm install ; cd ..
cd cloud\agent  ; npm install ; cd ..\..
.\panel\hud-launcher\build-hud.ps1
```

HUD-ът намира `panel\server.js` сам, като се изкачва нагоре от собственото си
местоположение — няма път за променяне.

Облачната част (Supabase + Vercel) **не изисква нищо** — тя не знае къде работи
сървърът. Само `cloud\agent\.env` трябва да е на новата машина.

### 2.9 Пускане и проверка

```powershell
.\START-SERVER.ps1
```

| Проверка | Очаквано |
|---|---|
| `setup\05-verify-no-client.ps1` | всичко зелено |
| `Auth.log` | `Added realm "..." at <новия адрес>` |
| `Playerbots.log` | ботове влизат |
| панел | http://localhost:8080 |
| отвън | тествай от телефон на мобилни данни, **не** от локалната мрежа |

⚠️ Тест отвътре в мрежата не доказва нищо — той минава по `localAddress`.

---

## Какво вече не може да се загуби

| Работа | Къде живее | Възстановява се с |
|---|---|---|
| 31 настройки | `setup\server-settings.conf` | `apply-settings.ps1` |
| Промяна в C++ кода | `setup\patches\001-*.patch` | `git apply` |
| Схема на базата | `setup\01-create-databases.sql` | `mysql < ...` |
| Акаунти, герои, GM права | `db-backup-<дата>\` | `restore-databases.ps1` |
| Админ панел + HUD | `panel\` | `npm install` + `build-hud.ps1` |
| Правила за защитната стена | `setup\06/07-*.ps1` | пускане с администратор |
| Облачен слой | Supabase + Vercel | нищо — не зависи от машината |
| Точни версии на кода | този файл, раздел 2.3 | `git checkout <hash>` |

Всички скриптове извеждат пътищата от собственото си местоположение. Няма
абсолютни пътища за редактиране никъде.

---

## Ако нещо се обърка

| Симптом | Причина |
|---|---|
| `0xc0000135`, нула редове в лога | липсва VC++ Redistributable или `libmysql.dll` |
| Прекъсва с `-1073740768` | липсва `legacy.dll` (виж 2.4) |
| `Failure to read line number 1` | `.conf` файл със записан BOM. Скриптовете пишат UTF-8 без BOM |
| Реалмът липсва в списъка | `address` не се разрешава, или грешна `localSubnetMask` |
| Клиентът минава входа и увисва | `localAddress` сочи към старата машина |
| Ботовете стоят на 1 ниво | `apply-settings.ps1` не е пуснат |
| Ботовете влизат веднага в подземието | пач 001 не е приложен, после построен наново |
| `LNK2001: boost::throw_exception` | загубено `/EHsc` (виж 2.4) |
| Всяко построяване е пълно | липсват изключенията на Defender |

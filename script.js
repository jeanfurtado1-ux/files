(() => {
  "use strict";

  /* =========================================
     CONFIGURAÇÕES
  ========================================= */

  const STORAGE_KEY = "amigaFiel.portal.v1";
  const GUEST_KEY = "amigaFiel.visitante.id";

  // Login público e demonstrativo.
  // Não representa autenticação segura de um sistema real.
  const ADMIN_EMAIL = "dono@amigafiel.demo";
  const ADMIN_PASSWORD = "AmigaFiel2026!";

  const CANCELLATION_HOURS = 24;

  const SERVICES = [
    "Consulta clínica",
    "Vacinação",
    "Exames laboratoriais",
    "Cirurgia",
    "Banho e tosa"
  ];

  const WEEKDAY_TIMES = [
    "08:00",
    "09:00",
    "10:00",
    "11:00",
    "13:00",
    "14:00",
    "15:00",
    "16:00",
    "17:00"
  ];

  const SATURDAY_TIMES = [
    "08:00",
    "09:00",
    "10:00",
    "11:00"
  ];

  const $ = (selector, root = document) => root.querySelector(selector);

  const portal = $("#portal");
  const portalContent = $("#portalContent");
  const bookingForm = $("#bookingForm");

  let loggedTutorId = null;
  let isAdmin = false;
  let currentView = null;
  let toastTimer = null;

  /* =========================================
     UTILITÁRIOS
  ========================================= */

  function uid() {
    return crypto.randomUUID();
  }

  function digits(value) {
    return String(value ?? "").replace(/\D/g, "");
  }

  function clean(value) {
    return String(value ?? "").trim().replace(/\s+/g, " ");
  }

  function normalize(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  // Evita transformar dados digitados pelo usuário em HTML executável.
  function escapeHTML(value) {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };

    return String(value ?? "").replace(/[&<>"']/g, char => map[char]);
  }

  function validEmail(value) {
    return (
      String(value).length <= 254 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim())
    );
  }

  function validPhone(value) {
    return /^[1-9]{2}(?:9\d{8}|[2-5]\d{7})$/.test(digits(value));
  }

  function validCPF(value) {
    const cpf = digits(value);

    if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) {
      return false;
    }

    for (let size = 9; size <= 10; size++) {
      let sum = 0;

      for (let index = 0; index < size; index++) {
        sum += Number(cpf[index]) * (size + 1 - index);
      }

      const expected = ((sum * 10) % 11) % 10;

      if (expected !== Number(cpf[size])) {
        return false;
      }
    }

    return true;
  }

  function validName(value) {
    const name = clean(value);

    return (
      name.length >= 2 &&
      name.length <= 80 &&
      /^[\p{L} ]+$/u.test(name)
    );
  }

  function todayISO() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());

    const values = Object.fromEntries(
      parts.map(part => [part.type, part.value])
    );

    return `${values.year}-${values.month}-${values.day}`;
  }

  function nextDayISO() {
    const date = new Date(`${todayISO()}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);

    return date.toISOString().slice(0, 10);
  }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }

    const date = new Date(`${value}T12:00:00Z`);

    return (
      !Number.isNaN(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }

  function dateLabel(value) {
    if (!validDate(value)) {
      return "Data não informada";
    }

    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }

  function appointmentTimestamp(booking) {
    // Horário de Brasília.
    return new Date(
      `${booking.data}T${booking.horario}:00-03:00`
    ).getTime();
  }

  function bookingStatus(booking) {
    const allowed = [
      "Pendente",
      "Confirmado",
      "Cancelado",
      "Concluído"
    ];

    return allowed.includes(booking.status)
      ? booking.status
      : "Pendente";
  }

  function canCancel(booking) {
    const active = ["Pendente", "Confirmado"].includes(
      bookingStatus(booking)
    );

    const remaining = appointmentTimestamp(booking) - Date.now();
    const minimum = CANCELLATION_HOURS * 60 * 60 * 1000;

    return active && remaining >= minimum;
  }

  function availableTimes(date) {
    if (!validDate(date)) {
      return [];
    }

    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();

    if (weekday === 0) {
      return [];
    }

    return weekday === 6 ? SATURDAY_TIMES : WEEKDAY_TIMES;
  }

  function slotTaken(db, date, time, exceptId = null) {
    return db.bookings.some(booking => (
      booking.id !== exceptId &&
      booking.data === date &&
      booking.horario === time &&
      bookingStatus(booking) !== "Cancelado"
    ));
  }

  function notify(message) {
    const toast = $("#toast");

    clearTimeout(toastTimer);

    toast.textContent = message;
    toast.hidden = false;

    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 5500);
  }

  /* =========================================
     ARMAZENAMENTO LOCAL

     ATENÇÃO — ponto de integração com back-end:
     Hoje tudo é lido/gravado no localStorage do navegador
     (readDatabase, saveDatabase, mutateDatabase). Quando a API
     própria existir, essas três funções são o único lugar que
     precisa mudar — troque localStorage.getItem/setItem por
     chamadas fetch() para os endpoints (ex: GET /api/db,
     PUT /api/db, ou operações específicas por recurso). O resto
     do código chama sempre mutateDatabase()/readDatabase(), então
     a troca fica isolada aqui.

     A senha aqui é hasheada só no navegador (ver hashPassword,
     abaixo) — isso é aceitável apenas como demonstração. Em
     produção, o hash de senha deve ser feito no servidor (ex:
     bcrypt/argon2), nunca confiando no cliente para isso.
  ========================================= */

  function emptyDatabase() {
    return {
      tutors: [],
      pets: [],
      records: [],
      bookings: []
    };
  }

  function readDatabase() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const db = raw ? JSON.parse(raw) : emptyDatabase();

      const valid = db && [
        "tutors",
        "pets",
        "records",
        "bookings"
      ].every(key => Array.isArray(db[key]));

      if (!valid) {
        throw new Error("Formato inválido.");
      }

      return db;
    } catch {
      throw new Error(
        "Não foi possível ler os dados deste navegador. " +
        "Os cadastros existentes não foram sobrescritos."
      );
    }
  }

  function saveDatabase(db) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch {
      throw new Error(
        "Não foi possível salvar. O armazenamento pode estar cheio " +
        "ou bloqueado. Tente uma foto menor."
      );
    }
  }

  // Evita alterações simultâneas entre abas quando o navegador
  // oferece suporte à API de bloqueios.
  async function mutateDatabase(callback) {
    const operation = () => {
      const db = readDatabase();
      const result = callback(db);

      saveDatabase(db);

      return result;
    };

    if (navigator.locks) {
      return navigator.locks.request(
        "amigaFiel.portal.mutation",
        operation
      );
    }

    return operation();
  }

  let guestId;

  try {
    guestId = sessionStorage.getItem(GUEST_KEY);

    if (!guestId) {
      guestId = uid();
      sessionStorage.setItem(GUEST_KEY, guestId);
    }
  } catch {
    guestId = uid();
  }

  function currentTutor(db = readDatabase()) {
    return db.tutors.find(tutor => tutor.id === loggedTutorId);
  }

  function ownsBooking(booking) {
    if (isAdmin) {
      return false;
    }

    if (loggedTutorId) {
      return booking.tutorId === loggedTutorId;
    }

    return !booking.tutorId && booking.guestId === guestId;
  }

  function getAccessiblePet(id, db = readDatabase()) {
    const pet = db.pets.find(item => item.id === id);

    if (!pet || (!isAdmin && pet.tutorId !== loggedTutorId)) {
      throw new Error("Pet não encontrado para este acesso.");
    }

    return pet;
  }

  function requireAdmin() {
    if (!isAdmin) {
      throw new Error("Esta ação é exclusiva da clínica.");
    }
  }

  /* =========================================
     SENHAS E FOTOS
  ========================================= */

  async function hashPassword(password, salt) {
    if (!crypto.subtle) {
      throw new Error(
        "Abra o projeto pelo Live Server no VS Code para criar a conta."
      );
    }

    const encoder = new TextEncoder();

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const result = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: encoder.encode(salt),
        iterations: 100000,
        hash: "SHA-256"
      },
      key,
      256
    );

    return Array.from(
      new Uint8Array(result),
      byte => byte.toString(16).padStart(2, "0")
    ).join("");
  }

  async function processPhoto(file) {
    if (!file || !file.size) {
      return "";
    }

    const allowed = ["image/jpeg", "image/png", "image/webp"];

    if (!allowed.includes(file.type)) {
      throw new Error("Use uma imagem JPG, PNG ou WebP.");
    }

    if (file.size > 2 * 1024 * 1024) {
      throw new Error("A foto deve ter no máximo 2 MB.");
    }

    const url = URL.createObjectURL(file);

    try {
      const image = new Image();

      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(
          new Error("Não foi possível abrir a foto.")
        );

        image.src = url;
      });

      const scale = Math.min(
        1,
        600 / Math.max(image.width, image.height)
      );

      const canvas = document.createElement("canvas");

      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));

      canvas.getContext("2d").drawImage(
        image,
        0,
        0,
        canvas.width,
        canvas.height
      );

      return canvas.toDataURL("image/jpeg", 0.8);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function photoHTML(pet, profile = false) {
    const valid = /^data:image\/(jpeg|png|webp);base64,/.test(
      pet.photo || ""
    );

    if (valid) {
      return `
        <img
          class="${profile ? "profile-photo" : "pet-photo"}"
          src="${escapeHTML(pet.photo)}"
          alt="Foto de ${escapeHTML(pet.name)}"
        >
      `;
    }

    return `<div class="pet-placeholder" aria-hidden="true">🐾</div>`;
  }

  /* =========================================
     COMPONENTES DE FORMULÁRIO E TELA
  ========================================= */

  function inputField(
    name,
    label,
    type = "text",
    value = "",
    extra = ""
  ) {
    return `
      <label>
        ${escapeHTML(label)}
        <input
          name="${name}"
          type="${type}"
          value="${escapeHTML(value)}"
          ${extra}
        >
      </label>
    `;
  }

  function selectField(name, label, options, selected = "") {
    return `
      <label>
        ${escapeHTML(label)}
        <select name="${name}" required>
          <option value="">Selecione</option>
          ${options.map(option => `
            <option
              value="${escapeHTML(option)}"
              ${option === selected ? "selected" : ""}
            >
              ${escapeHTML(option)}
            </option>
          `).join("")}
        </select>
      </label>
    `;
  }

  function actionButton(
    label,
    action,
    id = "",
    className = "button button-outline"
  ) {
    return `
      <button
        type="button"
        class="${className}"
        data-action="${action}"
        data-id="${escapeHTML(id)}"
      >
        ${escapeHTML(label)}
      </button>
    `;
  }

  function formFooter(text) {
    return `
      <button class="button button-primary full-width" type="submit">
        ${escapeHTML(text)}
      </button>
      <p class="form-feedback" role="status" aria-live="polite"></p>
    `;
  }

  function showView(title, description, html, setup) {
    portalContent.innerHTML = `
      <header class="portal-heading">
        <h2 id="portalTitle" tabindex="-1">${escapeHTML(title)}</h2>
        ${description ? `<p>${escapeHTML(description)}</p>` : ""}
      </header>
      ${html}
    `;

    if (!portal.open) {
      portal.showModal();
      document.body.classList.add("modal-open");
    }

    portal.scrollTop = 0;

    if (setup) {
      setup();
    }

    $("#portalTitle").focus();
  }

  function navigate(view, id = "") {
    currentView = { view, id };

    const routes = {
      login: () => loginView(false),
      adminLogin: () => loginView(true),
      register: registerView,
      dashboard: dashboardView,
      admin: adminView,
      tutorPets: () => tutorPetsView(id),
      pet: () => petView(id),
      addPet: () => petFormView(id),
      editPet: () => petFormView(null, id),
      editTutor: () => tutorFormView(id),
      history: () => historyView(id),
      record: () => recordFormView(id),
      appointments: appointmentsView
    };

    if (!routes[view]) {
      throw new Error("Tela não encontrada.");
    }

    routes[view]();
  }

  function closePortal() {
    portal.close();
  }

  function updateAccountButton() {
    $("#tutorAccess").textContent = loggedTutorId
      ? "Meus pets"
      : "Entrar / Cadastrar";
  }

  function bindForm(id, handler) {
    const form = document.getElementById(id);

    form.addEventListener("submit", async event => {
      event.preventDefault();

      if (!form.reportValidity()) {
        return;
      }

      const submit = form.querySelector('[type="submit"]');
      const feedback = $(".form-feedback", form);

      feedback.textContent = "";
      feedback.classList.remove("success");
      submit.disabled = true;

      const originalLabel = submit.textContent;
      submit.classList.add("is-loading");
      submit.textContent = "Enviando...";

      try {
        const data = Object.fromEntries(new FormData(form));
        await handler(data, form);
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        submit.disabled = false;
        submit.classList.remove("is-loading");
        submit.textContent = originalLabel;
      }
    });
  }

  function validateTutor(data) {
    if (!validName(data.name)) {
      throw new Error("Informe um nome com pelo menos duas letras.");
    }

    if (!validCPF(data.cpf)) {
      throw new Error("CPF inválido. Confira os 11 dígitos.");
    }

    if (!validEmail(data.email)) {
      throw new Error("Informe um e-mail válido.");
    }

    if (!validPhone(data.phone)) {
      throw new Error("Informe um telefone brasileiro válido com DDD.");
    }
  }

  function tutorFields(tutor = {}) {
    return `
      ${inputField(
        "name",
        "Nome completo",
        "text",
        tutor.name || "",
        'required minlength="2" maxlength="80" autocomplete="name"'
      )}

      <div class="form-grid">
        ${inputField(
          "cpf",
          "CPF",
          "text",
          tutor.cpf ? maskCPF(tutor.cpf) : "",
          'required maxlength="14" inputmode="numeric" placeholder="000.000.000-00" data-mask="cpf"'
        )}

        ${inputField(
          "phone",
          "Telefone com DDD",
          "tel",
          tutor.phone ? maskPhone(tutor.phone) : "",
          'required maxlength="15" inputmode="numeric" autocomplete="tel" placeholder="(00) 00000-0000" data-mask="phone"'
        )}
      </div>

      ${inputField(
        "email",
        "E-mail",
        "email",
        tutor.email || "",
        'required maxlength="254" autocomplete="email"'
      )}
    `;
  }

  function petFields(pet = {}) {
    return `
      ${inputField(
        "petName",
        "Nome do pet",
        "text",
        pet.name || "",
        'required maxlength="50"'
      )}

      <div class="form-grid">
        <label>
          Espécie
          <input
            name="species"
            list="speciesOptions"
            value="${escapeHTML(pet.species || "")}"
            maxlength="50"
            placeholder="Cachorro, gato, coelho..."
            required
          >
        </label>

        <datalist id="speciesOptions">
          <option value="Cachorro"></option>
          <option value="Gato"></option>
          <option value="Coelho"></option>
          <option value="Ave"></option>
        </datalist>

        ${inputField(
          "breed",
          "Raça — opcional",
          "text",
          pet.breed || "",
          'maxlength="50" placeholder="Ex.: sem raça definida"'
        )}
      </div>

      ${inputField(
        "birth",
        "Nascimento — opcional",
        "date",
        pet.birth || "",
        `min="1900-01-01" max="${todayISO()}"`
      )}

      <label>
        Foto do pet — opcional
        <input
          name="photo"
          type="file"
          accept="image/jpeg,image/png,image/webp"
        >
      </label>

      <p class="small">
        JPG, PNG ou WebP, até 2 MB.
        ${pet.id ? "Sem uma nova foto, a imagem atual será mantida." : ""}
      </p>
    `;
  }

  function validatePet(data) {
    if (!clean(data.petName) || clean(data.petName).length > 50) {
      throw new Error("Informe o nome do pet, com até 50 caracteres.");
    }

    if (
      clean(data.species).length < 2 ||
      clean(data.species).length > 50
    ) {
      throw new Error("Informe a espécie do animal.");
    }

    if (
      data.birth &&
      (
        !validDate(data.birth) ||
        data.birth < "1900-01-01" ||
        data.birth > todayISO()
      )
    ) {
      throw new Error("Informe uma data de nascimento válida.");
    }
  }

  /* =========================================
     LOGIN E CADASTRO CONJUNTO
  ========================================= */

  function loginView(admin) {
    showView(
      admin ? "Acesso do administrador" : "Área do tutor",
      admin
        ? "Gerencie cadastros, histórico e agendamentos da clínica."
        : "Entre para acompanhar seus pets e seus agendamentos.",
      `
        <form id="loginForm" class="portal-form">
          ${inputField(
            "email",
            "E-mail",
            "email",
            "",
            'required maxlength="254" autocomplete="username"'
          )}

          ${inputField(
            "password",
            "Senha",
            "password",
            "",
            'required maxlength="64" autocomplete="current-password"'
          )}

          ${formFooter("Entrar")}
        </form>

        ${admin ? `
          <div class="notice">
            <strong>Conta para apresentação</strong>
            <p>
              E-mail: ${ADMIN_EMAIL}<br>
              Senha: ${ADMIN_PASSWORD}
            </p>
            <small>Credenciais públicas, apenas para demonstração.</small>
          </div>
        ` : `
          <div class="actions">
            ${actionButton("Criar minha conta", "register")}
          </div>
        `}
      `,
      () => {
        bindForm("loginForm", async data => {
          const email = data.email.trim().toLowerCase();

          if (admin) {
            if (
              email !== ADMIN_EMAIL ||
              data.password !== ADMIN_PASSWORD
            ) {
              throw new Error("E-mail ou senha do administrador incorretos.");
            }

            isAdmin = true;
            loggedTutorId = null;
          } else {
            const db = readDatabase();

            const tutor = db.tutors.find(item => item.email === email);

            if (
              !tutor ||
              await hashPassword(data.password, tutor.salt) !== tutor.hash
            ) {
              throw new Error("E-mail ou senha incorretos.");
            }

            loggedTutorId = tutor.id;
            isAdmin = false;
          }

          bookingForm.reset();
          syncOtherSpecies();
          delete bookingForm.dataset.petId;

          updateAccountButton();
          renderPublicBookings();
          refreshTimes();

          navigate(admin ? "admin" : "dashboard");
        });
      }
    );
  }

  function registerView() {
    showView(
      "Cadastre você e seu pet",
      "A conta e o primeiro animal são cadastrados juntos.",
      `
        <form id="registerForm" class="portal-form">
          <h3>Seus dados</h3>

          ${tutorFields()}

          <div class="form-grid">
            ${inputField(
              "password",
              "Senha",
              "password",
              "",
              'required minlength="8" maxlength="64" autocomplete="new-password"'
            )}

            ${inputField(
              "passwordConfirm",
              "Repita a senha",
              "password",
              "",
              'required minlength="8" maxlength="64" autocomplete="new-password"'
            )}
          </div>

          <h3 class="form-section-title">Seu primeiro pet</h3>

          ${petFields()}

          <p class="notice">
            Após o cadastro, somente a clínica atualiza os dados
            e a foto do pet. Você poderá consultar o histórico
            e solicitar agendamentos.
          </p>

          ${formFooter("Criar conta e cadastrar pet")}
        </form>

        <div class="actions">
          ${actionButton("Já tenho conta", "login")}
        </div>
      `,
      () => {
        bindForm("registerForm", async data => {
          validateTutor(data);
          validatePet(data);

          if (data.password.trim().length < 8) {
            throw new Error("Use uma senha com pelo menos oito caracteres.");
          }

          if (data.password !== data.passwordConfirm) {
            throw new Error("As senhas não coincidem.");
          }

          const salt = uid();
          const hash = await hashPassword(data.password, salt);
          const photo = await processPhoto(data.photo);

          const tutorId = uid();
          const email = data.email.trim().toLowerCase();
          const cpf = digits(data.cpf);

          // Conta e pet são salvos na mesma operação.
          await mutateDatabase(db => {
            if (db.tutors.some(tutor => tutor.email === email)) {
              throw new Error("Este e-mail já possui uma conta.");
            }

            if (db.tutors.some(tutor => tutor.cpf === cpf)) {
              throw new Error("Este CPF já está cadastrado.");
            }

            db.tutors.push({
              id: tutorId,
              name: clean(data.name),
              cpf,
              phone: digits(data.phone),
              email,
              salt,
              hash
            });

            db.pets.push({
              id: uid(),
              tutorId,
              name: clean(data.petName),
              species: clean(data.species),
              breed: clean(data.breed),
              birth: data.birth,
              photo
            });
          });

          loggedTutorId = tutorId;
          isAdmin = false;

          updateAccountButton();
          renderPublicBookings();
          navigate("dashboard");

          notify("Conta e pet cadastrados.");
        });
      }
    );
  }

  /* =========================================
     PAINEL DO TUTOR E CARTÕES DOS PETS
  ========================================= */

  function petCards(pets) {
    if (!pets.length) {
      return `
        <div class="empty-state">
          <h3>Nenhum pet encontrado</h3>
          <p>Os animais cadastrados aparecerão aqui.</p>
        </div>
      `;
    }

    return `
      <div class="pets-grid">
        ${pets.map(pet => `
          <article class="pet-card">
            ${photoHTML(pet)}

            <div class="pet-body">
              <div class="pet-title">
                <h3>${escapeHTML(pet.name)}</h3>

                <details class="pet-menu">
                  <summary
                    aria-label="Opções de ${escapeHTML(pet.name)}"
                  >
                    ⋮
                  </summary>

                  <div>
                    ${actionButton(
                      "Ver cadastro",
                      "pet",
                      pet.id,
                      ""
                    )}

                    ${actionButton(
                      "Ver histórico",
                      "history",
                      pet.id,
                      ""
                    )}

                    ${isAdmin
                      ? actionButton("Editar pet", "editPet", pet.id, "")
                      : actionButton("Agendar", "bookPet", pet.id, "")
                    }

                    ${isAdmin
                      ? actionButton(
                          "Registrar atendimento",
                          "record",
                          pet.id,
                          ""
                        )
                      : ""
                    }
                  </div>
                </details>
              </div>

              <p>${escapeHTML(pet.species)}</p>
              <p class="small">
                ${escapeHTML(pet.breed || "Raça não informada")}
              </p>

              ${actionButton(
                "Ver histórico",
                "history",
                pet.id,
                "button button-outline button-small"
              )}
            </div>
          </article>
        `).join("")}
      </div>
    `;
  }

  function dashboardView() {
    const db = readDatabase();
    const tutor = currentTutor(db);

    if (!tutor || isAdmin) {
      navigate("login");
      return;
    }

    const pets = db.pets.filter(pet => pet.tutorId === tutor.id);

    showView(
      `Os companheiros de ${tutor.name.split(" ")[0]}`,
      "Consulte os dados e o histórico dos seus pets.",
      `
        <div class="actions">
          ${actionButton(
            "Cadastrar outro pet",
            "addPet",
            tutor.id,
            "button button-primary"
          )}

          ${actionButton("Meus agendamentos", "appointments")}
          ${actionButton("Sair da conta", "logout")}
        </div>

        <label>
          Buscar pet
          <input id="petSearch" type="search" placeholder="Nome do pet">
        </label>

        <div id="petResults">${petCards(pets)}</div>
      `,
      () => {
        $("#petSearch").addEventListener("input", event => {
          const query = normalize(event.target.value);

          $("#petResults").innerHTML = petCards(
            pets.filter(pet => normalize(pet.name).includes(query))
          );
        });
      }
    );
  }

  function petView(id) {
    const db = readDatabase();
    const pet = getAccessiblePet(id, db);
    const tutor = db.tutors.find(item => item.id === pet.tutorId);

    showView(
      pet.name,
      isAdmin
        ? "A clínica pode atualizar o cadastro deste animal."
        : "Para atualizar dados ou foto, solicite à clínica.",
      `
        ${photoHTML(pet, true)}

        <dl class="pet-info">
          <div>
            <dt>Espécie</dt>
            <dd>${escapeHTML(pet.species)}</dd>
          </div>

          <div>
            <dt>Raça</dt>
            <dd>${escapeHTML(pet.breed || "Não informada")}</dd>
          </div>

          <div>
            <dt>Nascimento</dt>
            <dd>${pet.birth ? dateLabel(pet.birth) : "Não informado"}</dd>
          </div>

          <div>
            <dt>Tutor</dt>
            <dd>${escapeHTML(tutor?.name || "")}</dd>
          </div>
        </dl>

        <div class="actions">
          ${actionButton(
            "Ver histórico",
            "history",
            pet.id,
            "button button-primary"
          )}

          ${isAdmin
            ? actionButton("Editar pet", "editPet", pet.id)
            : actionButton("Agendar atendimento", "bookPet", pet.id)
          }

          ${actionButton(
            "Voltar",
            isAdmin ? "tutorPets" : "dashboard",
            pet.tutorId
          )}
        </div>
      `
    );
  }

  /* =========================================
     CADASTRO E EDIÇÃO DE PETS
  ========================================= */

  function petFormView(tutorId, petId = null) {
    const db = readDatabase();
    let existing = null;

    if (petId) {
      requireAdmin();
      existing = getAccessiblePet(petId, db);
      tutorId = existing.tutorId;
    }

    if (!isAdmin && tutorId !== loggedTutorId) {
      throw new Error("Você não pode cadastrar um pet para outra conta.");
    }

    if (!db.tutors.some(tutor => tutor.id === tutorId)) {
      throw new Error("Tutor não encontrado.");
    }

    showView(
      existing ? `Editar ${existing.name}` : "Cadastrar outro pet",
      existing
        ? "Atualizações realizadas pela clínica."
        : "Depois do cadastro, as alterações serão feitas pela clínica.",
      `
        <form id="petForm" class="portal-form">
          ${petFields(existing || {})}
          ${formFooter(existing ? "Salvar alterações" : "Cadastrar pet")}
        </form>

        <div class="actions">
          ${actionButton(
            "Voltar",
            isAdmin ? "tutorPets" : "dashboard",
            tutorId
          )}
        </div>
      `,
      () => {
        bindForm("petForm", async data => {
          validatePet(data);

          if (petId) {
            requireAdmin();
          }

          const newPhoto = data.photo?.size
            ? await processPhoto(data.photo)
            : null;

          await mutateDatabase(currentDb => {
            if (!isAdmin && tutorId !== loggedTutorId) {
              throw new Error("Acesso não permitido.");
            }

            if (!currentDb.tutors.some(tutor => tutor.id === tutorId)) {
              throw new Error("Tutor não encontrado.");
            }

            const saved = {
              id: petId || uid(),
              tutorId,
              name: clean(data.petName),
              species: clean(data.species),
              breed: clean(data.breed),
              birth: data.birth,
              photo: newPhoto ?? existing?.photo ?? ""
            };

            if (petId) {
              requireAdmin();

              const index = currentDb.pets.findIndex(
                pet => pet.id === petId && pet.tutorId === tutorId
              );

              if (index < 0) {
                throw new Error("Pet não encontrado.");
              }

              currentDb.pets[index] = saved;
            } else {
              currentDb.pets.push(saved);
            }
          });

          navigate(isAdmin ? "tutorPets" : "dashboard", tutorId);
          notify("Cadastro do pet salvo.");
        });
      }
    );
  }

  /* =========================================
     ÁREA ADMINISTRATIVA
  ========================================= */

  function adminView() {
    requireAdmin();

    const db = readDatabase();

    function tutorRows(query = "") {
      const search = normalize(query);

      const tutors = db.tutors.filter(tutor => {
        const text = normalize(
          `${tutor.name} ${tutor.email} ${tutor.cpf}`
        );

        return text.includes(search);
      });

      if (!tutors.length) {
        return `
          <div class="empty-state">
            <p>Nenhum tutor encontrado.</p>
          </div>
        `;
      }

      return tutors.map(tutor => `
        <article class="tutor-item">
          <div>
            <strong>${escapeHTML(tutor.name)}</strong>
            <p>${escapeHTML(tutor.email)}</p>
            <p>${escapeHTML(tutor.phone)}</p>
          </div>

          ${actionButton("Ver pets", "tutorPets", tutor.id)}
        </article>
      `).join("");
    }

    showView(
      "Área do administrador",
      "Gerencie os clientes, animais, atendimentos e solicitações.",
      `
        <div class="actions">
          ${actionButton(
            "Gerenciar agendamentos",
            "appointments",
            "",
            "button button-primary"
          )}

          ${actionButton("Sair da área", "logout")}
        </div>

        <label>
          Buscar tutor por nome, e-mail ou CPF
          <input id="tutorSearch" type="search" maxlength="254">
        </label>

        <div id="tutorResults">${tutorRows()}</div>
      `,
      () => {
        $("#tutorSearch").addEventListener("input", event => {
          $("#tutorResults").innerHTML = tutorRows(event.target.value);
        });
      }
    );
  }

  function tutorPetsView(tutorId) {
    requireAdmin();

    const db = readDatabase();
    const tutor = db.tutors.find(item => item.id === tutorId);

    if (!tutor) {
      throw new Error("Tutor não encontrado.");
    }

    showView(
      tutor.name,
      `${tutor.email} · ${tutor.phone}`,
      `
        <div class="actions">
          ${actionButton("Voltar", "admin")}
          ${actionButton("Editar tutor", "editTutor", tutor.id)}
          ${actionButton(
            "Cadastrar pet",
            "addPet",
            tutor.id,
            "button button-primary"
          )}
        </div>

        ${petCards(db.pets.filter(pet => pet.tutorId === tutor.id))}
      `
    );
  }

  function tutorFormView(tutorId) {
    requireAdmin();

    const db = readDatabase();
    const tutor = db.tutors.find(item => item.id === tutorId);

    if (!tutor) {
      throw new Error("Tutor não encontrado.");
    }

    showView(
      "Atualizar cadastro do tutor",
      "Alterações realizadas pela clínica.",
      `
        <form id="tutorForm" class="portal-form">
          ${tutorFields(tutor)}
          ${formFooter("Salvar cadastro")}
        </form>

        <div class="actions">
          ${actionButton("Voltar", "tutorPets", tutorId)}
        </div>
      `,
      () => {
        bindForm("tutorForm", async data => {
          requireAdmin();
          validateTutor(data);

          const email = data.email.trim().toLowerCase();
          const cpf = digits(data.cpf);

          await mutateDatabase(currentDb => {
            requireAdmin();

            if (currentDb.tutors.some(item => (
              item.id !== tutorId &&
              (item.email === email || item.cpf === cpf)
            ))) {
              throw new Error("E-mail ou CPF já usado por outro tutor.");
            }

            const current = currentDb.tutors.find(
              item => item.id === tutorId
            );

            if (!current) {
              throw new Error("Tutor não encontrado.");
            }

            Object.assign(current, {
              name: clean(data.name),
              cpf,
              email,
              phone: digits(data.phone)
            });
          });

          navigate("tutorPets", tutorId);
          notify("Cadastro do tutor atualizado.");
        });
      }
    );
  }

  /* =========================================
     HISTÓRICO DO PET
  ========================================= */

  function historyView(petId) {
    const db = readDatabase();
    const pet = getAccessiblePet(petId, db);

    showView(
      `Histórico de ${pet.name}`,
      "Atendimentos registrados pela clínica, do mais recente ao mais antigo.",
      `
        <div class="actions">
          ${actionButton("Ver cadastro", "pet", pet.id)}

          ${isAdmin
            ? actionButton(
                "Registrar atendimento",
                "record",
                pet.id,
                "button button-primary"
              )
            : ""
          }

          ${actionButton("Imprimir histórico", "print")}
        </div>

        <div class="form-grid history-filters">
          <label>
            Categoria
            <select id="historyCategory">
              <option value="">Todas</option>
              ${SERVICES.map(service => `
                <option>${escapeHTML(service)}</option>
              `).join("")}
            </select>
          </label>

          <label>
            Buscar no histórico
            <input
              id="historySearch"
              type="search"
              placeholder="Vacina, procedimento..."
            >
          </label>
        </div>

        <div id="historyResults"></div>
      `,
      () => {
        const renderHistory = () => {
          const category = $("#historyCategory").value;
          const search = normalize($("#historySearch").value);

          const records = readDatabase().records
            .filter(record => (
              record.petId === pet.id &&
              (!category || record.type === category) &&
              normalize(
                `${record.title} ${record.notes} ${record.professional}`
              ).includes(search)
            ))
            .sort((a, b) => (
              b.date.localeCompare(a.date) ||
              String(b.createdAt).localeCompare(String(a.createdAt))
            ));

          $("#historyResults").innerHTML = records.length ? `
            <div class="timeline">
              ${records.map(record => `
                <article>
                  <p class="record-meta">
                    ${dateLabel(record.date)}
                    · ${escapeHTML(record.type)}
                  </p>

                  <h3>${escapeHTML(record.title)}</h3>

                  <p>
                    Responsável: ${escapeHTML(record.professional)}
                  </p>

                  ${record.notes
                    ? `<p>${escapeHTML(record.notes)}</p>`
                    : ""
                  }

                  ${record.nextDate ? `
                    <p>
                      <strong>Retorno / próxima dose:</strong>
                      ${dateLabel(record.nextDate)}
                    </p>
                  ` : ""}
                </article>
              `).join("")}
            </div>
          ` : `
            <div class="empty-state">
              <h3>Nenhum atendimento encontrado</h3>
              <p>Os registros da clínica aparecerão aqui.</p>
            </div>
          `;
        };

        $("#historyCategory").addEventListener("change", renderHistory);
        $("#historySearch").addEventListener("input", renderHistory);

        renderHistory();
      }
    );
  }

  function recordFormView(petId) {
    requireAdmin();

    const pet = getAccessiblePet(petId);

    showView(
      `Registrar cuidado de ${pet.name}`,
      "Registre somente atendimentos já realizados.",
      `
        <form id="recordForm" class="portal-form">
          <div class="form-grid">
            ${selectField("type", "Tipo de atendimento", SERVICES)}

            ${inputField(
              "date",
              "Data do atendimento",
              "date",
              todayISO(),
              `required min="1900-01-01" max="${todayISO()}"`
            )}
          </div>

          ${inputField(
            "title",
            "Vacina, procedimento ou serviço",
            "text",
            "",
            'required minlength="2" maxlength="100"'
          )}

          ${inputField(
            "professional",
            "Profissional responsável",
            "text",
            "",
            'required minlength="2" maxlength="80"'
          )}

          <label>
            Observações — opcional
            <textarea name="notes" maxlength="1000" rows="4"></textarea>
          </label>

          ${inputField(
            "nextDate",
            "Retorno ou próxima dose — opcional",
            "date"
          )}

          ${formFooter("Salvar atendimento")}
        </form>

        <div class="actions">
          ${actionButton("Voltar ao histórico", "history", pet.id)}
        </div>
      `,
      () => {
        bindForm("recordForm", async data => {
          requireAdmin();

          if (!SERVICES.includes(data.type)) {
            throw new Error("Escolha um tipo de atendimento válido.");
          }

          if (
            !validDate(data.date) ||
            data.date < "1900-01-01" ||
            data.date > todayISO()
          ) {
            throw new Error("A data deve ser válida e não futura.");
          }

          if (
            clean(data.title).length < 2 ||
            !validName(data.professional)
          ) {
            throw new Error("Confira o procedimento e o profissional.");
          }

          if (
            data.nextDate &&
            (
              !validDate(data.nextDate) ||
              data.nextDate <= data.date
            )
          ) {
            throw new Error(
              "A próxima data deve ser posterior ao atendimento."
            );
          }

          await mutateDatabase(db => {
            requireAdmin();
            getAccessiblePet(petId, db);

            db.records.push({
              id: uid(),
              petId,
              type: data.type,
              date: data.date,
              title: clean(data.title),
              professional: clean(data.professional),
              notes: data.notes.trim(),
              nextDate: data.nextDate,
              createdAt: new Date().toISOString()
            });
          });

          navigate("history", petId);
          notify("Atendimento registrado.");
        });
      }
    );
  }

  /* =========================================
     AGENDAMENTO PELO CADASTRO DO PET
  ========================================= */

  function bookPet(petId) {
    if (isAdmin || !loggedTutorId) {
      throw new Error("Entre na área do tutor para solicitar.");
    }

    const db = readDatabase();
    const pet = getAccessiblePet(petId, db);
    const tutor = currentTutor(db);

    if (!tutor) {
      throw new Error("Tutor não encontrado.");
    }

    const fields = bookingForm.elements;

    fields.tutorNome.value = tutor.name;
    fields.tutorTelefone.value = tutor.phone;
    fields.tutorEmail.value = tutor.email;
    fields.petNome.value = pet.name;

    const knownSpecies = ["Cachorro", "Gato"].includes(pet.species);

    fields.petEspecie.value = knownSpecies ? pet.species : "Outro";

    syncOtherSpecies();

    fields.petOutraEspecie.value = knownSpecies ? "" : pet.species;

    bookingForm.dataset.petId = pet.id;

    $(".form-feedback", bookingForm).textContent = "";

    closePortal();

    $("#agendamento").scrollIntoView({ behavior: "smooth" });
    fields.servico.focus({ preventScroll: true });
  }

  function syncOtherSpecies() {
    const other = bookingForm.elements.petEspecie.value === "Outro";
    const field = bookingForm.elements.petOutraEspecie;

    $("#otherSpeciesLabel").hidden = !other;
    field.disabled = !other;
    field.required = other;

    if (!other) {
      field.value = "";
    }
  }

  function refreshTimes() {
    const fields = bookingForm.elements;
    const date = fields.data.value;
    const selected = fields.horario.value;
    const db = readDatabase();

    fields.data.min = nextDayISO();

    const times = date >= nextDayISO() ? availableTimes(date) : [];

    fields.horario.innerHTML = `
      <option value="">
        ${times.length ? "Selecione" : "Escolha uma data disponível"}
      </option>

      ${times.map(time => {
        const busy = slotTaken(db, date, time);

        return `
          <option value="${time}" ${busy ? "disabled" : ""}>
            ${time}${busy ? " — ocupado" : ""}
          </option>
        `;
      }).join("")}
    `;

    if (
      times.includes(selected) &&
      !slotTaken(db, date, selected)
    ) {
      fields.horario.value = selected;
    }
  }

  bindForm("bookingForm", async (data, form) => {
    if (!validName(data.tutorNome)) {
      throw new Error("Confira o nome do tutor.");
    }

    if (
      !validPhone(data.tutorTelefone) ||
      !validEmail(data.tutorEmail)
    ) {
      throw new Error("Confira o telefone com DDD e o e-mail.");
    }

    if (!clean(data.petNome)) {
      throw new Error("Informe o nome do pet.");
    }

    if (!["Cachorro", "Gato", "Outro"].includes(data.petEspecie)) {
      throw new Error("Selecione a espécie.");
    }

    const species = data.petEspecie === "Outro"
      ? clean(data.petOutraEspecie)
      : data.petEspecie;

    if (species.length < 2) {
      throw new Error("Informe a espécie do animal.");
    }

    if (!SERVICES.includes(data.servico)) {
      throw new Error("Selecione um serviço válido.");
    }

    if (
      !validDate(data.data) ||
      data.data < nextDayISO() ||
      !availableTimes(data.data).includes(data.horario)
    ) {
      throw new Error(
        "Escolha uma data a partir de amanhã, de segunda a sábado, " +
        "e um horário disponível."
      );
    }

    const petId = form.dataset.petId || null;

    await mutateDatabase(db => {
      if (slotTaken(db, data.data, data.horario)) {
        throw new Error(
          "Este horário já foi reservado. Escolha outro horário."
        );
      }

      let linkedPet = null;

      if (petId) {
        linkedPet = db.pets.find(pet => (
          pet.id === petId &&
          pet.tutorId === loggedTutorId
        ));

        if (
          !linkedPet ||
          linkedPet.name !== clean(data.petNome) ||
          linkedPet.species !== species
        ) {
          throw new Error(
            "Para alterar o cadastro do pet, fale com a clínica. " +
            "Volte ao perfil e solicite o agendamento novamente."
          );
        }
      }

      const tutor = currentTutor(db);

      db.bookings.push({
        id: uid(),
        tutorId: tutor?.id || null,
        guestId: tutor ? null : guestId,
        petId: linkedPet?.id || null,
        tutorNome: tutor?.name || clean(data.tutorNome),
        tutorTelefone: tutor?.phone || digits(data.tutorTelefone),
        tutorEmail: tutor?.email || data.tutorEmail.trim().toLowerCase(),
        petNome: linkedPet?.name || clean(data.petNome),
        petEspecie: linkedPet?.species || species,
        servico: data.servico,
        data: data.data,
        horario: data.horario,
        observacoes: data.observacoes.trim(),
        status: "Pendente",
        createdAt: new Date().toISOString()
      });
    });

    form.reset();
    delete form.dataset.petId;

    syncOtherSpecies();
    refreshTimes();
    renderPublicBookings();

    const feedback = $(".form-feedback", form);

    feedback.classList.add("success");
    feedback.textContent =
      "Solicitação salva como Pendente. A clínica poderá confirmar " +
      "pela área administrativa deste navegador. Nenhuma mensagem foi enviada.";
  });

  /* =========================================
     CONFIRMAÇÃO POR WHATSAPP E E-MAIL
  ========================================= */

  function notificationLinks(booking) {
    if (bookingStatus(booking) !== "Confirmado") {
      return "";
    }

    const message =
      `Olá, ${booking.tutorNome}! ` +
      `A clínica Amiga Fiel confirmou ${booking.servico} ` +
      `de ${booking.petNome} para ${dateLabel(booking.data)} ` +
      `às ${booking.horario}, horário de Brasília. ` +
      `O cancelamento pelo site pode ser feito até 24 horas antes. ` +
      `Depois desse prazo, fale com a clínica.`;

    const whatsapp =
      `https://wa.me/55${digits(booking.tutorTelefone)}` +
      `?text=${encodeURIComponent(message)}`;

    const email =
      `mailto:${encodeURIComponent(booking.tutorEmail)}` +
      `?subject=${encodeURIComponent("Consulta confirmada — Amiga Fiel")}` +
      `&body=${encodeURIComponent(message)}`;

    return `
      ${validPhone(booking.tutorTelefone) ? `
        <a
          class="button button-outline button-small"
          href="${escapeHTML(whatsapp)}"
          target="_blank"
          rel="noopener noreferrer"
        >
          Abrir WhatsApp
        </a>
      ` : ""}

      ${validEmail(booking.tutorEmail) ? `
        <a
          class="button button-outline button-small"
          href="${escapeHTML(email)}"
        >
          Preparar e-mail
        </a>
      ` : ""}

      <p class="small">
        Revise e envie no aplicativo.
        A mensagem não é enviada automaticamente.
      </p>
    `;
  }

  /* =========================================
     LISTAGEM E STATUS DOS AGENDAMENTOS
  ========================================= */

  function appointmentCards(bookings, admin = false) {
    if (!bookings.length) {
      return `
        <div class="empty-state">
          <p>Nenhum agendamento encontrado.</p>
        </div>
      `;
    }

    return bookings.map(booking => {
      const status = bookingStatus(booking);
      const active = ["Pendente", "Confirmado"].includes(status);

      let controls = "";

      if (admin) {
        if (status === "Pendente") {
          controls += actionButton(
            "Confirmar",
            "confirmBooking",
            booking.id,
            "button button-primary button-small"
          );
        }

        if (status === "Confirmado") {
          controls += actionButton(
            "Concluir",
            "finishBooking",
            booking.id,
            "button button-outline button-small"
          );
        }

        if (active) {
          controls += actionButton(
            "Cancelar",
            "cancelBooking",
            booking.id,
            "button button-danger button-small"
          );
        }

        controls += notificationLinks(booking);
      } else if (active) {
        controls = canCancel(booking)
          ? actionButton(
              "Cancelar consulta",
              "cancelBooking",
              booking.id,
              "button button-danger button-small"
            )
          : `
            <p class="small">
              O prazo de cancelamento pelo site terminou.
              Entre em contato com a clínica.
            </p>
          `;
      }

      return `
        <article class="booking-item">
          <div>
            <strong>
              ${escapeHTML(booking.servico)}
              — ${escapeHTML(booking.petNome)}
            </strong>

            <p>
              ${dateLabel(booking.data)} às ${escapeHTML(booking.horario)}
              <br>Horário de Brasília
            </p>

            ${admin ? `
              <p>
                Tutor: ${escapeHTML(booking.tutorNome)}<br>
                ${escapeHTML(booking.tutorTelefone)}<br>
                ${escapeHTML(booking.tutorEmail)}
              </p>

              ${booking.observacoes
                ? `<p>Observações: ${escapeHTML(booking.observacoes)}</p>`
                : ""
              }
            ` : ""}

            <span class="status status-${normalize(status)}">
              ${status}
            </span>
          </div>

          <div class="appointment-actions">
            ${controls}
          </div>
        </article>
      `;
    }).join("");
  }

  function renderPublicBookings() {
    const db = readDatabase();

    const bookings = db.bookings
      .filter(ownsBooking)
      .slice()
      .reverse();

    $("#publicBookings").innerHTML = appointmentCards(bookings);
  }

  function appointmentsView() {
    if (!isAdmin && !loggedTutorId) {
      navigate("login");
      return;
    }

    showView(
      isAdmin ? "Agenda da clínica" : "Meus agendamentos",
      "O cliente pode cancelar até 24 horas antes. " +
      "Depois desse prazo, o cancelamento deve ser tratado com a clínica.",
      `
        <div class="actions">
          ${actionButton("Voltar", isAdmin ? "admin" : "dashboard")}
        </div>

        <div class="form-grid">
          <label>
            Filtrar por data
            <input id="bookingDateFilter" type="date">
          </label>

          <label>
            Filtrar por status
            <select id="bookingStatusFilter">
              <option value="">Todos</option>
              <option>Pendente</option>
              <option>Confirmado</option>
              <option>Cancelado</option>
              <option>Concluído</option>
            </select>
          </label>
        </div>

        <p id="appointmentFeedback" role="status"></p>
        <div id="appointmentResults"></div>
      `,
      () => {
        $("#bookingDateFilter").addEventListener(
          "change",
          renderAppointmentResults
        );

        $("#bookingStatusFilter").addEventListener(
          "change",
          renderAppointmentResults
        );

        renderAppointmentResults();
      }
    );
  }

  function renderAppointmentResults() {
    const container = $("#appointmentResults");

    if (!container) {
      return;
    }

    const db = readDatabase();
    const date = $("#bookingDateFilter").value;
    const status = $("#bookingStatusFilter").value;

    const bookings = db.bookings
      .filter(booking => (
        (isAdmin || ownsBooking(booking)) &&
        (!date || booking.data === date) &&
        (!status || bookingStatus(booking) === status)
      ))
      .sort((a, b) => (
        `${a.data}${a.horario}`.localeCompare(`${b.data}${b.horario}`)
      ));

    container.innerHTML = appointmentCards(bookings, isAdmin);
  }

  async function changeBookingStatus(id, newStatus) {
    if (newStatus === "Cancelado") {
      const confirmed = window.confirm(
        "Deseja cancelar este agendamento? " +
        "O registro será mantido como Cancelado e o horário será liberado."
      );

      if (!confirmed) {
        return;
      }
    }

    await mutateDatabase(db => {
      const booking = db.bookings.find(item => item.id === id);

      if (!booking || (!isAdmin && !ownsBooking(booking))) {
        throw new Error("Agendamento não encontrado para este acesso.");
      }

      const current = bookingStatus(booking);

      if (!["Pendente", "Confirmado"].includes(current)) {
        throw new Error("Este agendamento já foi encerrado.");
      }

      if (!isAdmin) {
        if (newStatus !== "Cancelado") {
          throw new Error("Somente a clínica pode confirmar consultas.");
        }

        if (!canCancel(booking)) {
          throw new Error(
            "O cancelamento pelo site exige pelo menos 24 horas " +
            "de antecedência. Entre em contato com a clínica."
          );
        }
      }

      if (newStatus === "Confirmado") {
        requireAdmin();

        if (current !== "Pendente") {
          throw new Error("A consulta não está pendente.");
        }

        if (appointmentTimestamp(booking) <= Date.now()) {
          throw new Error(
            "Este horário já passou. Cancele e faça uma nova solicitação."
          );
        }

        if (
          slotTaken(
            db,
            booking.data,
            booking.horario,
            booking.id
          )
        ) {
          throw new Error("Existe outra reserva para este horário.");
        }
      }

      if (newStatus === "Concluído") {
        requireAdmin();

        if (
          current !== "Confirmado" ||
          appointmentTimestamp(booking) > Date.now()
        ) {
          throw new Error(
            "Só é possível concluir uma consulta confirmada " +
            "cujo horário já chegou."
          );
        }
      }

      if (!["Confirmado", "Cancelado", "Concluído"].includes(newStatus)) {
        throw new Error("Status inválido.");
      }

      booking.status = newStatus;
      booking.updatedAt = new Date().toISOString();
    });

    renderPublicBookings();
    refreshTimes();
    renderAppointmentResults();

    if ($("#appointmentFeedback")) {
      $("#appointmentFeedback").textContent =
        `Agendamento atualizado: ${newStatus}.`;
    } else {
      notify(`Agendamento atualizado: ${newStatus}.`);
    }
  }

  /* =========================================
     AÇÕES DOS BOTÕES DINÂMICOS
  ========================================= */

  async function handleAction(action, id) {
    if (action === "logout") {
      const wasAdmin = isAdmin;

      isAdmin = false;
      loggedTutorId = null;

      bookingForm.reset();
      delete bookingForm.dataset.petId;

      syncOtherSpecies();
      refreshTimes();
      updateAccountButton();
      renderPublicBookings();

      navigate(wasAdmin ? "adminLogin" : "login");
      return;
    }

    if (action === "bookPet") {
      bookPet(id);
      return;
    }

    if (action === "confirmBooking") {
      await changeBookingStatus(id, "Confirmado");
      return;
    }

    if (action === "cancelBooking") {
      await changeBookingStatus(id, "Cancelado");
      return;
    }

    if (action === "finishBooking") {
      await changeBookingStatus(id, "Concluído");
      return;
    }

    if (action === "print") {
      window.print();
      return;
    }

    navigate(action, id);
  }

  document.addEventListener("click", async event => {
    const button = event.target.closest("button[data-action]");

    if (!button || button.disabled) {
      return;
    }

    button.disabled = true;

    try {
      await handleAction(button.dataset.action, button.dataset.id);
    } catch (error) {
      const feedback = $("#appointmentFeedback");

      if (portal.open && feedback) {
        feedback.textContent = error.message;
      } else if (portal.open) {
        window.alert(error.message);
      } else {
        notify(error.message);
      }
    } finally {
      button.disabled = false;
    }
  });

  /* =========================================
     MENU DE TRÊS PONTOS
  ========================================= */

  const menuToggle = $("#menuToggle");
  const siteMenu = $("#siteMenu");

  function setMenu(open) {
    siteMenu.hidden = !open;

    menuToggle.setAttribute("aria-expanded", String(open));

    menuToggle.setAttribute(
      "aria-label",
      open ? "Fechar menu de navegação" : "Abrir menu de navegação"
    );
  }

  menuToggle.addEventListener("click", () => {
    setMenu(siteMenu.hidden);
  });

  siteMenu.querySelectorAll("a").forEach(link => {
    link.addEventListener("click", () => setMenu(false));
  });

  document.addEventListener("click", event => {
    if (
      !siteMenu.contains(event.target) &&
      !menuToggle.contains(event.target)
    ) {
      setMenu(false);
    }

    document.querySelectorAll(".pet-menu[open]").forEach(menu => {
      if (!menu.contains(event.target)) {
        menu.open = false;
      }
    });
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !siteMenu.hidden) {
      setMenu(false);
      menuToggle.focus();
    }
  });

  function openTutorArea() {
    setMenu(false);
    isAdmin = false;

    try {
      navigate(loggedTutorId ? "dashboard" : "login");
    } catch (error) {
      notify(error.message);
    }
  }

  function openAdminArea() {
    setMenu(false);

    try {
      navigate(isAdmin ? "admin" : "adminLogin");
    } catch (error) {
      notify(error.message);
    }
  }

  $("#tutorAccess").addEventListener("click", openTutorArea);
  $("#menuTutor").addEventListener("click", openTutorArea);
  $("#menuAdmin").addEventListener("click", openAdminArea);
  $("#footerAdmin").addEventListener("click", openAdminArea);
  document.querySelectorAll('[data-open-tutor]').forEach(button => {
    button.addEventListener('click', openTutorArea);
  });
  $("#closePortal").addEventListener("click", closePortal);

  portal.addEventListener("close", () => {
    document.body.classList.remove("modal-open");
  });

  /* =========================================
     ASSISTENTE EXPANSÍVEL
  ========================================= */

  const helpPanel = $("#assistantPanel");
  const helpToggle = $("#assistantToggle");

  const helpAnswers = {
    cadastro:
      "Clique em Entrar / Cadastrar e depois em Criar minha conta. " +
      "Preencha seus dados e os dados do primeiro pet no mesmo formulário. " +
      "Você também pode enviar uma foto.",

    agendamento:
      "Na área do tutor, abra os três pontinhos do pet e escolha Agendar. " +
      "O pedido começa como Pendente. A clínica pode mudar para " +
      "Confirmado ou Cancelado. Confira em Meus agendamentos.",

    cancelamento:
      "Você pode cancelar consultas pendentes ou confirmadas até " +
      "24 horas antes. Exemplo: para 30/09 às 08h, o limite é " +
      "29/09 às 08h. Depois disso, entre em contato com a clínica.",

    historico:
      "Abra o cartão do pet e escolha Ver histórico. A clínica registra " +
      "vacinas, consultas, cirurgias, exames e banho e tosa com as datas. " +
      "Somente a clínica altera os dados já cadastrados.",

    mensagem:
      "Depois de confirmar o atendimento, o administrador pode abrir " +
      "uma mensagem pronta no WhatsApp ou no aplicativo de e-mail. " +
      "O envio é manual. Esta versão não envia mensagens automaticamente."
  };

  function setHelp(open) {
    helpPanel.hidden = !open;
    helpToggle.setAttribute("aria-expanded", String(open));

    if (open) {
      $("#closeAssistant").focus();
    } else {
      helpToggle.focus();
    }
  }

  helpToggle.addEventListener("click", () => {
    setHelp(helpPanel.hidden);
  });

  $("#closeAssistant").addEventListener("click", () => setHelp(false));

  helpPanel.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      setHelp(false);
    }
  });

  document.querySelectorAll("[data-help]").forEach(button => {
    button.addEventListener("click", () => {
      $("#assistantAnswer").textContent = helpAnswers[button.dataset.help];
    });
  });

  /* =========================================
     INICIALIZAÇÃO E ATUALIZAÇÃO ENTRE ABAS
  ========================================= */

  bookingForm.elements.petEspecie.addEventListener(
    "change",
    syncOtherSpecies
  );

  bookingForm.elements.data.addEventListener("change", () => {
    try {
      refreshTimes();
    } catch (error) {
      notify(error.message);
    }
  });

  window.addEventListener("storage", event => {
    if (event.key !== STORAGE_KEY) {
      return;
    }

    try {
      renderPublicBookings();
      refreshTimes();

      if (portal.open && currentView) {
        const { view, id } = currentView;

        // Evita apagar formulários que estejam sendo preenchidos.
        if ([
          "dashboard",
          "admin",
          "tutorPets",
          "pet",
          "history"
        ].includes(view)) {
          navigate(view, id);
        }

        if (view === "appointments") {
          renderAppointmentResults();
        }
      }
    } catch (error) {
      notify(error.message);
    }
  });

  $("#year").textContent = new Date().getFullYear();

  try {
    syncOtherSpecies();
    refreshTimes();
    renderPublicBookings();
    updateAccountButton();
  } catch (error) {
    notify(error.message);
  }

  /* =========================================
     AVISO DE CONTEXTO INSEGURO
     Sem isso, crypto.subtle fica indisponível e o
     cadastro falha silenciosamente para quem abre o
     arquivo com duplo clique em vez de usar um servidor
     local (Live Server, http-server, etc).
  ========================================= */

  if (!window.isSecureContext) {
    const banner = document.createElement("div");
    banner.className = "insecure-context-banner";
    banner.setAttribute("role", "alert");

    banner.innerHTML = `
      <strong>Abra este site por um servidor local.</strong>
      Use a extensão Live Server no VS Code (clique com o botão
      direito em index.html → "Open with Live Server"). Abrindo o
      arquivo direto (duplo clique), o cadastro de conta não funciona.
    `;

    document.body.prepend(banner);
  }

  /* =========================================
     MÁSCARAS DE CPF E TELEFONE
     Aplica-se a qualquer input com data-mask="cpf"
     ou data-mask="phone", inclusive campos gerados
     dinamicamente dentro do portal.
  ========================================= */

  function maskCPF(value) {
    return digits(value)
      .slice(0, 11)
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  }

  function maskPhone(value) {
    const raw = digits(value).slice(0, 11);

    if (raw.length <= 10) {
      return raw
        .replace(/(\d{2})(\d)/, "($1) $2")
        .replace(/(\d{4})(\d)/, "$1-$2");
    }

    return raw
      .replace(/(\d{2})(\d)/, "($1) $2")
      .replace(/(\d{5})(\d)/, "$1-$2");
  }

  document.addEventListener("input", event => {
    const field = event.target;
    const mask = field.dataset && field.dataset.mask;

    if (!mask) {
      return;
    }

    const cursorFromEnd = field.value.length - field.selectionStart;

    field.value = mask === "cpf"
      ? maskCPF(field.value)
      : maskPhone(field.value);

    const position = field.value.length - cursorFromEnd;
    field.setSelectionRange(position, position);
  });

  /* =========================================
     VALIDAÇÃO EM TEMPO REAL
     Mostra o erro assim que o campo perde o foco,
     em vez de só no envio do formulário.
  ========================================= */

  const fieldValidators = {
    name: value => validName(value) || "Informe um nome com pelo menos duas letras.",
    cpf: value => validCPF(value) || "CPF inválido. Confira os 11 dígitos.",
    email: value => validEmail(value) || "Informe um e-mail válido.",
    phone: value => validPhone(value) || "Informe um telefone brasileiro válido com DDD.",
    tutorNome: value => validName(value) || "Informe um nome com pelo menos duas letras.",
    tutorEmail: value => validEmail(value) || "Informe um e-mail válido.",
    tutorTelefone: value => validPhone(value) || "Informe um telefone brasileiro válido com DDD."
  };

  function fieldErrorElement(field) {
    let error = field.parentElement.querySelector(".field-error");

    if (!error) {
      error = document.createElement("small");
      error.className = "field-error";
      error.setAttribute("role", "alert");
      field.parentElement.appendChild(error);
    }

    return error;
  }

  document.addEventListener("focusout", event => {
    const field = event.target;
    const validator = field.name && fieldValidators[field.name];

    if (!validator || !field.value) {
      return;
    }

    const result = validator(field.value);
    const error = fieldErrorElement(field);

    if (result === true) {
      field.removeAttribute("aria-invalid");
      error.textContent = "";
    } else {
      field.setAttribute("aria-invalid", "true");
      error.textContent = result;
    }
  }, true);

  document.addEventListener("input", event => {
    const field = event.target;

    if (field.getAttribute("aria-invalid") === "true") {
      field.removeAttribute("aria-invalid");

      const error = field.parentElement.querySelector(".field-error");
      if (error) {
        error.textContent = "";
      }
    }
  });
})();
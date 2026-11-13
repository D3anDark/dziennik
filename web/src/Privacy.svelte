<script>
  import { api } from './api.svelte.js';
  import { t } from './i18n.js';

  /** The notice RODO art. 13 asks for: who keeps what, why, for how long, and what you can ask for. */
  let operator = $state('');
  api('about')
    .then((b) => (operator = b?.operator ?? ''))
    .catch(() => {});
</script>

<div class="privacy">
  <p>
    <strong>{t('Administrator danych:')}</strong>
    {operator || t('osoba, która uruchomiła ten serwer. Nie podała tu swoich danych; zapytaj ją o nie, zanim się zalogujesz.')}
  </p>
  <p>
    <strong>{t('Co serwer zapisuje:')}</strong> {t('Twój adres e-mail i\u00a0tokeny dostępu do konta LIBRUS. Hasła nie zapisuje. Gdy włączysz powiadomienia, także adres usługi powiadomień Twojej przeglądarki, wybrane na nim rodzaje powiadomień i\u00a0godziny ciszy oraz historię zmian: rodzaj i\u00a0numer wpisu, bez jego treści. Dla powiadomień o\u00a0przerwach serwer trzyma w\u00a0pamięci, bez zapisu, dzisiejsze lekcje ucznia: godziny, przedmioty i\u00a0sale.')}
  </p>
  <p>
    <strong>{t('Szyfrowanie:')}</strong> {t('tokeny są zaszyfrowane kluczem, który jest tylko w\u00a0ciasteczku Twojej sesji. Serwer go nie przechowuje, więc bez Twojego zalogowanego urządzenia nikt, także administrator, nie odczyta ich z\u00a0bazy danych ani z\u00a0kopii zapasowej. Wyjątek to powiadomienia: żeby sprawdzać Librusa, gdy aplikacja jest zamknięta, serwer trzyma wtedy kopię tokenów, którą otwiera sam. Wyłączenie powiadomień na ostatnim urządzeniu usuwa tę kopię i\u00a0historię zmian.')}
  </p>
  <p>
    <strong>{t('Czego szyfrowanie nie chroni:')}</strong> {t('hasło przy logowaniu i\u00a0dane z\u00a0dziennika przechodzą przez serwer w\u00a0chwili, gdy z\u00a0nich korzystasz. Administrator, który zmieniłby kod serwera, mógłby je wtedy przechwycić. Korzystaj tylko z\u00a0serwera osoby, której ufasz. Ostrzeżenie o\u00a0wersji niezgodnej z\u00a0oficjalnym repozytorium serwer wystawia sam o\u00a0sobie: zmieniony serwer może je ukryć, więc jego brak niczego nie dowodzi.')}
  </p>
  <p>
    <strong>{t('Cel i\u00a0podstawa:')}</strong> {t('pokazanie danych z\u00a0Twojego konta LIBRUS na Twoje żądanie (art.\u00a06 ust.\u00a01 lit.\u00a0b RODO). Powiadomienia na podstawie zgody (art.\u00a06 ust.\u00a01 lit.\u00a0a RODO), którą wycofujesz, wyłączając je.')}
  </p>
  <p>
    <strong>{t('Komu trafiają dane:')}</strong> {t('Librusowi, o\u00a0którego dane serwer pyta w\u00a0Twoim imieniu; usłudze powiadomień Twojej przeglądarki (Google, Apple, Mozilla lub Microsoft, także poza EOG), która dostaje tylko zaszyfrowaną treść; firmie, u\u00a0której stoi serwer.')}
  </p>
  <p>
    <strong>{t('Jak długo:')}</strong> {t('sesja wygasa najpóźniej 30 dni po ostatnim użyciu, a\u00a0wtedy znika wszystko, co jej dotyczy. Wylogowanie z\u00a0ostatniego urządzenia albo „Usuń moje dane” kasuje dane od razu. Historia zmian to najwyżej 300 wpisów na ucznia. Adres na liście dostępu zostaje, dopóki administrator go nie usunie. Przy adresie z\u00a0listy administrator widzi, czy ktoś się z\u00a0niego zalogował, a\u00a0po nieudanej próbie jej czas i\u00a0powód (np. złe hasło), bez hasła; ta notatka jest tylko w\u00a0pamięci serwera i\u00a0znika po udanym logowaniu, usunięciu adresu albo restarcie.')}
  </p>
  <p>
    <strong>{t('Twoje prawa:')}</strong> {t('dostęp do danych, ich sprostowanie, usunięcie, ograniczenie przetwarzania, przeniesienie i\u00a0sprzeciw. Usunięcie: przycisk „Usuń moje dane” w\u00a0Ustawieniach; o\u00a0resztę poproś administratora. Możesz złożyć skargę do Prezesa UODO (uodo.gov.pl). Podanie danych jest dobrowolne, ale bez nich aplikacja nie działa. Nikt nie podejmuje na ich podstawie zautomatyzowanych decyzji.')}
  </p>
</div>

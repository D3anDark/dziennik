<script>
  import { api } from './api.svelte.js';

  /** The notice RODO art. 13 asks for: who keeps what, why, for how long, and what you can ask for. */
  let operator = $state('');
  api('about')
    .then((b) => (operator = b?.operator ?? ''))
    .catch(() => {});
</script>

<div class="privacy">
  <p>
    <strong>Administrator danych:</strong>
    {operator || 'osoba, która uruchomiła ten serwer. Nie podała tu swoich danych; zapytaj ją o nie, zanim się zalogujesz.'}
  </p>
  <p>
    <strong>Co serwer zapisuje:</strong> Twój adres e-mail i&nbsp;tokeny dostępu do konta LIBRUS. Hasła nie zapisuje. Gdy
    włączysz powiadomienia, także adres usługi powiadomień Twojej przeglądarki, wybrane na nim rodzaje powiadomień oraz
    historię zmian: rodzaj i&nbsp;numer wpisu, bez jego treści. Dla powiadomień o&nbsp;przerwach serwer trzyma
    w&nbsp;pamięci, bez zapisu, dzisiejsze lekcje ucznia: godziny, przedmioty i&nbsp;sale.
  </p>
  <p>
    <strong>Szyfrowanie:</strong> tokeny są zaszyfrowane kluczem, który jest tylko w&nbsp;ciasteczku Twojej sesji. Serwer go
    nie przechowuje, więc bez Twojego zalogowanego urządzenia nikt, także administrator, nie odczyta ich z&nbsp;bazy
    danych ani z&nbsp;kopii zapasowej. Wyjątek to powiadomienia: żeby sprawdzać Librusa, gdy aplikacja jest zamknięta,
    serwer trzyma wtedy kopię tokenów, którą otwiera sam. Wyłączenie powiadomień na ostatnim urządzeniu usuwa tę kopię
    i&nbsp;historię zmian.
  </p>
  <p>
    <strong>Czego szyfrowanie nie chroni:</strong> hasło przy logowaniu i&nbsp;dane z&nbsp;dziennika przechodzą przez serwer
    w&nbsp;chwili, gdy z&nbsp;nich korzystasz. Administrator, który zmieniłby kod serwera, mógłby je wtedy przechwycić.
    Korzystaj tylko z&nbsp;serwera osoby, której ufasz. Ostrzeżenie o&nbsp;wersji niezgodnej z&nbsp;oficjalnym repozytorium
    serwer wystawia sam o&nbsp;sobie: zmieniony serwer może je ukryć, więc jego brak niczego nie dowodzi.
  </p>
  <p>
    <strong>Cel i&nbsp;podstawa:</strong> pokazanie danych z&nbsp;Twojego konta LIBRUS na Twoje żądanie (art.&nbsp;6 ust.&nbsp;1
    lit.&nbsp;b RODO). Powiadomienia na podstawie zgody (art.&nbsp;6 ust.&nbsp;1 lit.&nbsp;a RODO), którą wycofujesz,
    wyłączając je.
  </p>
  <p>
    <strong>Komu trafiają dane:</strong> Librusowi, o&nbsp;którego dane serwer pyta w&nbsp;Twoim imieniu; usłudze powiadomień
    Twojej przeglądarki (Google, Apple, Mozilla lub Microsoft, także poza EOG), która dostaje tylko zaszyfrowaną treść;
    firmie, u&nbsp;której stoi serwer.
  </p>
  <p>
    <strong>Jak długo:</strong> sesja wygasa najpóźniej 30 dni po ostatnim użyciu, a&nbsp;wtedy znika wszystko, co jej
    dotyczy. Wylogowanie z&nbsp;ostatniego urządzenia albo „Usuń moje dane” kasuje dane od razu. Historia zmian to
    najwyżej 300 wpisów na ucznia. Adres na liście dostępu zostaje, dopóki administrator go nie usunie.
  </p>
  <p>
    <strong>Twoje prawa:</strong> dostęp do danych, ich sprostowanie, usunięcie, ograniczenie przetwarzania, przeniesienie
    i&nbsp;sprzeciw. Usunięcie: przycisk „Usuń moje dane” w&nbsp;zakładce Więcej; o&nbsp;resztę poproś administratora.
    Możesz złożyć skargę do Prezesa UODO (uodo.gov.pl). Podanie danych jest dobrowolne, ale bez nich aplikacja nie
    działa. Nikt nie podejmuje na ich podstawie zautomatyzowanych decyzji.
  </p>
</div>

const content = document.getElementById("content");
const navLinks = document.querySelectorAll(".navbar a[data-page]");

// `open` names a project case study to open once the projects page is in (see data-open links).
async function loadPage(page, open) {
    document.dispatchEvent(new CustomEvent("page:will-change", { detail: { page } }));
    const response = await fetch(`pages/${page}.html`);
    const html = await response.text();
    content.innerHTML = html;
    updateActiveNavLink(page);
    document.dispatchEvent(new CustomEvent("page:loaded", { detail: { page, open } }));
}

function updateActiveNavLink(activePage) {
    navLinks.forEach(link => {
        if (link.dataset.page === activePage) {
            link.classList.add("active");
        } else {
            link.classList.remove("active");
        }
    });
}

document.addEventListener("click", event => {
    const link = event.target.closest("a[data-page]");
    if (!link) {
        return;
    }

    event.preventDefault();
    const page = link.dataset.page;
    loadPage(page, link.dataset.open);
});

document.addEventListener("click", event => {
    const filterButton = event.target.closest(".project-filter");
    if (!filterButton) {
        return;
    }

    const filter = filterButton.dataset.filter;

    document.querySelectorAll(".project-filter").forEach(button => {
        button.classList.remove("active");
    });

    filterButton.classList.add("active");

    document.querySelectorAll(".projects-page-card").forEach(project => {
        project.hidden =
            filter !== "all" &&
            project.dataset.category !== filter;
    });
});

loadPage(/^#projects\/[\w-]+$/.test(location.hash) ? "projects" : "about");
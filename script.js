const container = document.getElementById("notesContainer");
const searchInput = document.getElementById("search");
const sectionFilter = document.getElementById("sectionFilter");
const courseFilter = document.getElementById("courseFilter");
const uploadForm = document.getElementById("uploadForm");
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

async function fetchNotes(search = "", section = "", course = "") {
  const params = new URLSearchParams();
  if (search) params.append("search", search);
  if (section) params.append("section", section);
  if (course) params.append("course", course);

  const response = await fetch(`/api/notes?${params.toString()}`);
  if (!response.ok) {
    throw new Error("Failed to fetch notes");
  }
  return response.json();
}

function displayNotes(data) {
  container.innerHTML = "";

  if (!data.length) {
    container.innerHTML = "<p style='text-align:center;'>No notes found</p>";
    return;
  }

  data.forEach((note) => {
    const card = document.createElement("div");
    card.className = "note-card";

    const title = document.createElement("h3");
    title.textContent = note.title;

    const course = document.createElement("p");
    course.textContent = "Course: " + note.course;

    const section = document.createElement("p");
    section.textContent = "Section: " + note.section;

    card.appendChild(title);
    card.appendChild(course);
    card.appendChild(section);

    if (note.file) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Download";
      button.addEventListener("click", () => {
        window.location.href = `/api/notes?download=${encodeURIComponent(note.id)}`;
      });
      card.appendChild(button);
    }

    container.appendChild(card);
  });
}

async function loadNotes() {
  try {
    const data = await fetchNotes();
    displayNotes(data);
  } catch (error) {
    console.error("Failed to load notes", error);
    container.innerHTML = "<p style='text-align:center;'>Failed to load notes</p>";
  }
}

async function filterNotes() {
  const search = searchInput.value.toLowerCase();
  const section = sectionFilter.value;
  const course = courseFilter.value;

  try {
    const data = await fetchNotes(search, section, course);
    displayNotes(data);
  } catch (error) {
    console.error("Failed to filter notes", error);
    container.innerHTML = "<p style='text-align:center;'>Failed to filter notes</p>";
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const value = String(reader.result || "");
      const commaIndex = value.indexOf(",");
      resolve(commaIndex >= 0 ? value.slice(commaIndex + 1) : value);
    };

    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

searchInput.addEventListener("input", filterNotes);
sectionFilter.addEventListener("change", filterNotes);
courseFilter.addEventListener("change", filterNotes);

uploadForm.addEventListener("submit", async function handleSubmit(event) {
  event.preventDefault();

  const title = document.getElementById("title").value.trim();
  const course = document.getElementById("course").value;
  const section = document.getElementById("section").value;
  const file = document.getElementById("file").files[0];

  if (!title || !course || !section || !file) {
    alert("Please fill all fields correctly");
    return;
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    alert("File is too large. Please upload a file smaller than 3 MB.");
    return;
  }

  try {
    const payload = {
      title,
      course,
      section,
      fileName: file.name,
      fileType: file.type || "application/octet-stream",
      fileData: await fileToBase64(file)
    };

    const response = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let message = `Upload failed (${response.status})`;
      const errorBody = await response.json().catch(() => null);
      if (errorBody && errorBody.error) {
        message = String(errorBody.error);
      } else {
        const errorText = await response.text().catch(() => "");
        if (errorText) {
          message = errorText.slice(0, 160);
        }
      }

      alert("Error: " + message);
      return;
    }

    alert("Note uploaded successfully");
    this.reset();
    await loadNotes();
  } catch (error) {
    console.error("Upload failed", error);
    alert("Upload failed");
  }
});

loadNotes();
